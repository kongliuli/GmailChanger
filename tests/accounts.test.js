import test from 'node:test';
import assert from 'node:assert/strict';
import CHANGE_EMAIL_SITES from '../src/data/change-email.js';
import { classifyAccountMessage, createAccountSummary, changeEmailLink, EVIDENCE_KEYS, MAX_UNCLASSIFIED_SHOWN } from '../src/accounts.js';
import { accountsCsv, accountsMarkdown } from '../src/exports.js';

test('classifies account evidence from subject patterns and header signals', () => {
  assert.equal(classifyAccountMessage({ subject: 'Reset your password now' }), 'security');
  assert.equal(classifyAccountMessage({ subject: '您的两步验证码 482913' }), 'security');
  assert.equal(classifyAccountMessage({ subject: 'Password reset requested' }), 'security');
  assert.equal(classifyAccountMessage({ subject: 'Thanks for signing up!' }), 'signup');
  assert.equal(classifyAccountMessage({ subject: '您的账户已创建，请激活' }), 'signup');
  assert.equal(classifyAccountMessage({ subject: 'Please verify your email address' }), 'verify');
  assert.equal(classifyAccountMessage({ subject: '482913 is your verification code' }), 'verify');
  assert.equal(classifyAccountMessage({ subject: '验证码：902101' }), 'verify');
  assert.equal(classifyAccountMessage({ subject: 'Your order #12345 has shipped' }), 'receipt');
  assert.equal(classifyAccountMessage({ subject: '您的发票 / Invoice March' }), 'receipt');
  assert.equal(classifyAccountMessage({ subject: 'Welcome to Acme' }), 'welcome');
  // Strong security evidence wins even when a List-Unsubscribe header exists.
  assert.equal(classifyAccountMessage({ subject: 'Your login code is 223344', listUnsubscribe: true }), 'security');
});

test('marketing mail is demoted and never counts as account evidence', () => {
  assert.equal(classifyAccountMessage({ subject: 'Welcome to our newsletter', listUnsubscribe: true }), 'mailing-list');
  assert.equal(classifyAccountMessage({ subject: 'Weekly digest' , listUnsubscribe: true }), 'mailing-list');
  assert.equal(classifyAccountMessage({ subject: 'Welcome to Acme', listUnsubscribe: true, autoSubmitted: true }), 'welcome');
  assert.equal(classifyAccountMessage({ subject: 'Lunch tomorrow?' }), 'none');
  assert.equal(classifyAccountMessage({}), 'none');
});

test('summary aggregates counts, dates, samples and partitions buckets', () => {
  const summary = createAccountSummary();
  summary.add({ domain: 'acme.example', name: 'Acme', category: 'welcome', time: 1000, id: '<a@x>' });
  summary.add({ domain: 'acme.example', name: 'Acme', category: 'verify', time: 2000, id: '<b@x>' });
  summary.add({ domain: 'acme.example', name: 'Acme', category: 'welcome', time: 500, id: '<c@x>' });
  summary.add({ domain: 'news.example', category: 'mailing-list', time: 1500, id: '<d@x>' });
  summary.add({ domain: 'friend.example', category: 'none', time: 1500, id: '<e@x>' });
  summary.add({ domain: null, category: 'none' });
  const report = summary.report();
  assert.equal(report.evidence.length, 1);
  assert.equal(report.evidence[0].domain, 'acme.example');
  assert.equal(report.evidence[0].counts.welcome, 2);
  assert.equal(report.evidence[0].counts.verify, 1);
  assert.equal(report.evidence[0].first, 500);
  assert.equal(report.evidence[0].last, 2000);
  assert.equal(report.evidence[0].samples.length, 3);
  assert.equal(report.mailingOnly.length, 1);
  assert.equal(report.mailingOnly[0].domain, 'news.example');
  assert.equal(report.unclassified.total, 1);
  assert.equal(report.unclassified.shown[0].domain, 'friend.example');
  assert.equal(report.unknownFrom, 1);
  const snapshot = summary.snapshot();
  assert.equal(snapshot.records.length, 3);
  assert.ok(snapshot.records.every(record => EVIDENCE_KEYS.every(key => Number.isInteger(record.counts[key]))));
});

test('snapshots merge across files and cap new domains beyond the limit', () => {
  const first = createAccountSummary();
  first.add({ domain: 'a.example', category: 'signup', time: 100, id: '<1@x>' });
  const second = createAccountSummary();
  second.add({ domain: 'a.example', category: 'receipt', time: 300, id: '<2@x>' });
  second.add({ domain: 'b.example', category: 'welcome', time: 200, id: '<3@x>' });
  const merged = createAccountSummary();
  merged.absorb(first.snapshot());
  merged.absorb(second.snapshot());
  const record = merged.snapshot().records.find(item => item.domain === 'a.example');
  assert.equal(record.counts.signup, 1);
  assert.equal(record.counts.receipt, 1);
  assert.equal(record.first, 100);
  assert.equal(record.last, 300);
  const capped = createAccountSummary({ maxDomains: 1 });
  capped.add({ domain: 'a.example', category: 'signup' });
  capped.add({ domain: 'b.example', category: 'signup' });
  assert.equal(capped.snapshot().overflowDomains, 1);
  assert.equal(capped.report().evidence.length, 1);
});

test('change-email catalog is well formed and lookup covers aliases', () => {
  const seen = new Set();
  for (const site of CHANGE_EMAIL_SITES) {
    assert.match(site.domain, /^[a-z0-9.-]+$/, `${site.domain} must be a lowercase domain`);
    assert.ok(!seen.has(site.domain), `duplicate domain ${site.domain}`);
    seen.add(site.domain);
    assert.equal(typeof site.name, 'string');
    assert.ok(site.name.length > 0);
    assert.ok(site.url || site.note, `${site.domain} needs a url or a note`);
    if (site.url) {
      assert.match(site.url, /^https:\/\/\S+$/);
      assert.ok(!/\s/.test(site.url));
    }
    for (const alias of site.aliases || []) assert.match(alias, /^[a-z0-9.-]+$/);
  }
  assert.equal(changeEmailLink('gmail.com').domain, 'google.com');
  assert.equal(changeEmailLink('unknown.example'), null);
  assert.equal(changeEmailLink(null), null);
});

function fixtureReport() {
  const summary = createAccountSummary();
  summary.add({ domain: 'acme.example', name: 'Acme', category: 'welcome', time: Date.UTC(2022, 0, 1), id: '<a@x>' });
  summary.add({ domain: 'news.example', category: 'mailing-list', time: Date.UTC(2022, 0, 2), id: '<b@x>' });
  summary.add({ domain: 'friend.example', category: 'none', time: Date.UTC(2022, 0, 3), id: '<c@x>' });
  return summary.report();
}

test('accounts CSV separates buckets and escapes values', () => {
  const summary = createAccountSummary();
  summary.add({ domain: 'acme.example', name: '"Quote" Co', category: 'signup', time: Date.UTC(2022, 0, 1), id: '' });
  const csv = accountsCsv(summary.report());
  assert.match(csv, /^\uFEFF分类,域名/);
  assert.match(csv, /"有账号证据","acme\.example","""Quote"" Co",1,0,0,0,0,0,1/);
  assert.doesNotMatch(csv, /=HYPERLINK/);
});

test('accounts markdown lists evidence, notes uncertainty and catalog gaps', () => {
  const markdown = accountsMarkdown(fixtureReport());
  assert.match(markdown, /# 账号清点报告/);
  assert.match(markdown, /不保证完整/);
  assert.match(markdown, /\*\*acme\.example\*\*（Acme）/);
  assert.match(markdown, /未收录/);
  assert.match(markdown, /## 仅通讯（1 个域名/);
  assert.match(markdown, /news\.example — 通讯 1 封/);
  assert.match(markdown, /friend\.example — 1 封/);
});

test('unclassified display is truncated with an explicit count', () => {
  assert.equal(MAX_UNCLASSIFIED_SHOWN, 200);
  const summary = createAccountSummary({ maxDomains: 1000 });
  for (let i = 0; i < 205; i++) summary.add({ domain: `d${i}.example`, category: 'none' });
  const report = summary.report();
  assert.equal(report.unclassified.total, 205);
  assert.equal(report.unclassified.shown.length, 200);
});
