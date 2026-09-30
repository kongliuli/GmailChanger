// Header-only account evidence classifier. See docs/account-inventory-design.md:
// marketing mail never counts as account evidence; anything uncertain stays
// visible in the unclassified bucket instead of being silently dropped.
import CHANGE_EMAIL_SITES from './data/change-email.js';

export const EVIDENCE_KEYS = ['signup', 'verify', 'receipt', 'welcome', 'security'];
export const MAX_DOMAINS = 50000;
export const MAX_UNCLASSIFIED_SHOWN = 200;

const SECURITY = /(?:password|passwd|passcode)[^.\n]{0,24}(?:reset|recover|chang)|(?:reset|recover|chang)\w*[^.\n]{0,24}(?:password|passwd)|(?:forgot|change) (?:your )?(?:password|login)|two[- ]factor|2fa\b|\botp\b|one[- ]time (?:code|password|passcode)|(?:login|authentication) code|找回密码|重置密码|修改密码|密码重置|两步验证|动态口令|ワンタイムパスワード|二段階認証/i;
const SIGNUP = /thanks? for (?:signing up|joining|registering|creating)|sign[- ]?up (?:complete|success|confirm)|registration (?:complete|confirm|success)|account (?:has been |is )?(?:created|activated)|注册成功|账户?已(?:创建|激活|开通)|会員登録|가입을 환영|환영합니다/i;
const VERIFY = /(?:verif|confirm|validat|activat)\w*[^.\n]{0,24}(?:email|address|account|mailbox)|(?:verification|security) code|验证(?:你的)?(?:邮箱|邮件地址|账号|账户)|确认(?:您的)?(?:邮箱|邮件地址)|激活(?:您的)?(?:账号|账户)|認証コード|検証コード|メールアドレスの確認|인증(?:\s*번호|코드)/i;
const CODE = /(?:code|passcode|验证码|認証コード|인증)[^.\n]{0,16}\b\d{4,8}\b|^\s*\d{4,8}\s+(?:is|为|是)\b/i;
const RECEIPT = /receipt|invoice|your order|order (?:#|no\.?|number|confirm|shipped|placed|status)|payment (?:received|confirm)|purchase (?:complete|confirm)|subscription (?:renew|confirm)|billing statement|收据|发票|订单|付款成功|支付成功|扣款|订阅|续费|账单|領収書|請求書|注文|결제/i;
const WELCOME = /welcome|欢迎|歡迎|ようこそ|환영/i;

/** Classify one message from header signals only. Strong account evidence wins
 * over unsubscribe hints; a bare "welcome" with newsletter markers is demoted. */
export function classifyAccountMessage({ subject = '', listUnsubscribe = false, autoSubmitted = false, xAutoResponseSuppress = false } = {}) {
  const text = String(subject ?? '');
  const transactional = autoSubmitted || xAutoResponseSuppress;
  if (SECURITY.test(text)) return 'security';
  if (SIGNUP.test(text)) return 'signup';
  if (VERIFY.test(text)) return 'verify';
  if (CODE.test(text)) return 'verify';
  if (RECEIPT.test(text)) return 'receipt';
  if (WELCOME.test(text) && (!listUnsubscribe || transactional)) return 'welcome';
  if (listUnsubscribe) return 'mailing-list';
  return 'none';
}

const emptyCounts = () => ({ signup: 0, verify: 0, receipt: 0, welcome: 0, security: 0 });

/** Accumulates per-sender-domain evidence. snapshot() is structured-clone safe
 * for the Worker boundary; report() shapes the three review buckets. */
export function createAccountSummary({ maxDomains = MAX_DOMAINS } = {}) {
  const records = new Map();
  let overflowDomains = 0, unknownFrom = 0;
  const touch = (domain, name) => {
    let record = records.get(domain);
    if (!record) {
      if (records.size >= maxDomains) { overflowDomains++; return null; }
      record = { domain, name: '', messageCount: 0, mailingCount: 0, counts: emptyCounts(), first: null, last: null, samples: [] };
      records.set(domain, record);
    }
    if (name && !record.name) record.name = name;
    return record;
  };
  return {
    add({ domain, name = '', category, time = null, id = '' }) {
      if (!domain) { unknownFrom++; return; }
      const record = touch(domain, name);
      if (!record) return;
      record.messageCount++;
      if (category === 'mailing-list') record.mailingCount++;
      else if (category && category !== 'none') record.counts[category]++;
      if (time !== null && Number.isFinite(time)) {
        if (record.first === null || time < record.first) record.first = time;
        if (record.last === null || time > record.last) record.last = time;
      }
      if (id && record.samples.length < 3 && !record.samples.includes(id)) record.samples.push(id);
    },
    absorb(summary) {
      if (!summary) return;
      overflowDomains += summary.overflowDomains || 0;
      unknownFrom += summary.unknownFrom || 0;
      for (const incoming of summary.records || []) {
        const record = touch(incoming.domain, incoming.name);
        if (!record) continue;
        record.messageCount += incoming.messageCount || 0;
        record.mailingCount += incoming.mailingCount || 0;
        for (const key of EVIDENCE_KEYS) record.counts[key] += incoming.counts?.[key] || 0;
        for (const bound of ['first', 'last']) {
          const value = incoming[bound];
          if (value !== null && value !== undefined && (record[bound] === null || (bound === 'first' ? value < record[bound] : value > record[bound]))) record[bound] = value;
        }
        for (const id of incoming.samples || []) if (record.samples.length < 3 && !record.samples.includes(id)) record.samples.push(id);
      }
    },
    snapshot() {
      return { records: [...records.values()], overflowDomains, unknownFrom };
    },
    report() {
      const evidence = [], mailingOnly = [], unclassified = [];
      for (const record of records.values()) {
        const total = EVIDENCE_KEYS.reduce((sum, key) => sum + record.counts[key], 0);
        if (total) evidence.push({ ...record, total });
        else if (record.mailingCount) mailingOnly.push(record);
        else if (record.messageCount) unclassified.push(record);
      }
      const byDomain = (a, b) => a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
      evidence.sort((a, b) => b.total - a.total || byDomain(a, b));
      mailingOnly.sort((a, b) => b.mailingCount - a.mailingCount || byDomain(a, b));
      unclassified.sort((a, b) => b.messageCount - a.messageCount || byDomain(a, b));
      return { evidence, mailingOnly, unclassified: { total: unclassified.length, shown: unclassified.slice(0, MAX_UNCLASSIFIED_SHOWN) }, overflowDomains, unknownFrom };
    },
  };
}

const LINK_INDEX = new Map();
for (const site of CHANGE_EMAIL_SITES) for (const domain of [site.domain, ...(site.aliases || [])]) LINK_INDEX.set(domain, site);

/** Crowdsourced-style change-email lookup; never fabricates an entry. */
export function changeEmailLink(domain) {
  return LINK_INDEX.get(String(domain || '').toLowerCase()) || null;
}
