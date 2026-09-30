// Conservative capability allowlists, not proof that a user's server accepts a script.
export const TARGETS = [
  {
    id: 'generic', label: '通用 Sieve', kind: 'sieve', verifyStatus: 'unverified',
    extensions: ['fileinto'], supportsFlags: false, supportsRedirect: true, supportsVariables: false,
    maxActiveRules: null, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Trash',
    reserved: ['Inbox', 'Archive', 'Trash', 'Sent', 'Drafts', 'Junk'],
    notes: ['仅以 RFC 5228 核心命令与 fileinto 子集为基线；未连接真实服务器验证。', '服务器必须实际提供 fileinto；Archive/Trash 只是约定名称，请核对文件夹、分隔符与扩展能力。', '未列出的扩展按不支持处理；规则上限未知不等于无限。'],
    docsUrl: 'https://www.rfc-editor.org/rfc/rfc5228',
  },
  {
    id: 'fastmail', label: 'Fastmail', kind: 'sieve', verifyStatus: 'unverified',
    extensions: ['fileinto', 'imap4flags', 'copy', 'body', 'variables'],
    supportsFlags: true, supportsRedirect: true, supportsVariables: true,
    maxActiveRules: null, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Trash',
    reserved: ['Inbox', 'Archive', 'Trash', 'Sent', 'Drafts', 'Junk'],
    notes: ['能力列表是文档层面的候选能力，未在真实 Fastmail 账户测试，不保证导入成功。', '请在 Sieve 编辑器检查脚本，并核对实际文件夹路径、账户套餐及转发限制；规则上限未知。'],
    docsUrl: 'https://www.fastmail.help/hc/en-us/articles/1500000280481-Using-Sieve-scripts-in-Fastmail',
  },
  {
    id: 'proton', label: 'Proton Mail', kind: 'sieve', verifyStatus: 'unverified',
    extensions: ['fileinto', 'imap4flags', 'body', 'variables'],
    supportsFlags: true, supportsRedirect: false, supportsVariables: true,
    maxActiveRules: 1, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Trash',
    reserved: ['Inbox', 'Archive', 'Trash', 'Sent', 'Drafts', 'Spam', 'All Mail'],
    notes: ['未在真实 Proton Mail 账户测试；Sieve 编辑及可用功能需核对付费套餐。', '免费套餐仅允许 1 个活动过滤器；本配置保守采用此上限，付费套餐请按账户实际限制确认。Sieve 脚本中的条件块不一定等于账户活动过滤器数量。', '不声明支持 Sieve redirect 或 copy；账户转发功能不能当作 redirect 兼容性证明。', '请预先创建目标文件夹或标签；系统文件夹与自定义文件夹路径须在编辑器确认。'],
    docsUrl: 'https://proton.me/support/sieve-advanced-custom-filters',
  },
  {
    id: 'outlook', label: 'Outlook.com', kind: 'recipe', verifyStatus: 'manual',
    extensions: [], supportsFlags: false, supportsRedirect: false, supportsVariables: false,
    maxActiveRules: null, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Deleted Items',
    reserved: ['Inbox', 'Archive', 'Deleted Items', 'Sent Items', 'Drafts', 'Junk Email'],
    notes: ['Outlook.com 网页版没有本工具所需的 Sieve 规则文件导入；桌面 Outlook 的规则导入不是同一功能。', '请在设置 → 邮件 → 规则中逐条创建；条件、动作、顺序及停止处理行为需手动核对，未做真实账户测试。', '系统文件夹名称会随界面语言变化；请选取账户中的实际文件夹。规则上限未知。'],
    docsUrl: 'https://support.microsoft.com/outlook',
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', kind: 'recipe', verifyStatus: 'manual',
    extensions: [], supportsFlags: false, supportsRedirect: false, supportsVariables: false,
    maxActiveRules: null, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Trash',
    reserved: ['Inbox', 'Archive', 'Trash', 'Sent', 'Drafts', 'Spam'],
    notes: ['Yahoo Mail 没有本工具所需的 Sieve 规则文件导入；必须在设置 → 更多设置 → 过滤器中手工重建。', '普通过滤器主要用于按条件移动邮件；不要假定支持 Gmail 的星标、标签、已读或逐规则转发语义。未做真实账户测试。', '过滤器顺序、实际文件夹名称及账户限制须自行核对；规则上限未知。'],
    docsUrl: 'https://help.yahoo.com/kb/mail',
  },
  {
    id: 'unknown', label: '尚未确定', kind: 'sieve', verifyStatus: 'unverified',
    extensions: ['fileinto'], supportsFlags: false, supportsRedirect: true, supportsVariables: false,
    maxActiveRules: null, folderDelimiter: '/', archiveFolder: 'Archive', trashFolder: 'Trash',
    reserved: ['Inbox', 'Archive', 'Trash', 'Sent', 'Drafts', 'Junk'],
    notes: ['目标尚未确定，仅暂用通用 RFC 5228 与 fileinto 子集；这不是兼容性承诺。', '导入前必须确认服务商支持 Sieve、fileinto、实际文件夹名称及规则限制；未做真实服务器测试。'],
  },
];

export function getTarget(id) {
  const target = TARGETS.find(target => target.id === id);
  if (!target) throw new Error(`未知目标服务商：${String(id)}`);
  return target;
}

export function capabilityCheck(target, { extensions = [], actions = [], ruleCount = 0 } = {}) {
  const supported = [], unsupported = [];
  const record = (ok, message) => (ok ? supported : unsupported).push(message);
  const sieve = target.kind === 'sieve';
  for (const extension of new Set(extensions)) {
    const ok = sieve && target.extensions.includes(extension);
    record(ok, `扩展 ${extension}：${ok ? '在候选能力列表中，仍需实际验证' : '不支持或尚未确认，不能生成依赖它的规则'}`);
  }
  // ponytail: allowlist only; unknown actions must never pass through as compatible.
  const actionExtensions = { fileinto: 'fileinto', addflag: 'imap4flags', setflag: 'imap4flags', removeflag: 'imap4flags', set: 'variables' };
  for (const action of new Set(actions)) {
    const needed = Object.hasOwn(actionExtensions, action) ? actionExtensions[action] : null;
    let ok = sieve && ['keep', 'discard', 'stop'].includes(action);
    if (action === 'redirect') ok = sieve && target.supportsRedirect;
    if (needed) ok = sieve && target.extensions.includes(needed)
      && (needed !== 'imap4flags' || target.supportsFlags)
      && (needed !== 'variables' || target.supportsVariables);
    record(ok, `动作 ${action}：${ok ? '候选支持，仍需验证实际语义' : `不支持或尚未确认${needed ? `（需要 ${needed} 能力）` : ''}，请手工核对，不可静默忽略`}`);
  }
  if (target.maxActiveRules !== null && ruleCount > target.maxActiveRules) {
    unsupported.push(`账户活动过滤器数量 ${ruleCount} 超过保守上限 ${target.maxActiveRules}；这不等同于单个脚本中的条件块数量，请确认套餐限制。`);
  }
  return { supported, unsupported };
}

export function defaultFolders(target) {
  return { archiveFolder: target.archiveFolder, trashFolder: target.trashFolder, reserved: [...target.reserved] };
}

export function buildRecipe(target, results) {
  const lines = [`# ${target.label} 手工规则配方`, '', target.kind === 'recipe'
    ? '该服务商没有本工具所需的规则文件导入功能，因此这是手工配方，不是可导入脚本。'
    : '这是手工配方，不是兼容性证明；仅在账户没有可用的规则文件导入入口时按此手工重建。',
  '', '**未翻译的规则不得静默丢弃：每条规则都必须核对、手工处理或明确记录无法迁移的原因。**', '', '## 目标注意事项',
  ...target.notes.map(note => `- ${note}`), '', '目标动作对照：label → 核对标签或文件夹；shouldArchive → 归档并核对收件箱保留行为；shouldTrash → 移到垃圾箱而非永久删除；shouldMarkAsRead / shouldStar → 核对已读或星标；forwardTo → 仅在账户支持并确认转发限制时配置。不能等价实现时保留为待处理。'];
  for (const [index, result] of results.entries()) {
    const description = String(result.description ?? '（缺少原始说明，必须回查 Gmail）');
    // Fence raw descriptions as text; do not interpret or reconstruct Gmail query syntax.
    const fence = '`'.repeat(Math.max(3, ...Array.from(description.matchAll(/`+/g), match => match[0].length + 1)));
    const issues = (result.issues || []).map(issue => String(issue).replace(/[^\s<>"'()]+@[^\s<>"'()]+/g, address => description.includes(address) ? address : '[邮箱已省略]'));
    lines.push('', `## 规则 ${index + 1}`, '', '### 原始 Gmail 规则', fence, description, fence,
      '', '### 目标动作', '按上方原始说明中 → 右侧的动作逐项核对；这是待人工映射的动作，不表示目标服务商已支持。',
      '', '### 手工步骤',
      '1. 打开目标邮箱的规则或过滤器设置，新建规则，并对照原始 Gmail 条件逐项填写；无法表达的条件不要删掉后继续。',
      '2. 按动作对照选择实际存在的目标文件夹和可用动作；不支持的动作记录为待处理，不启用不完整规则。',
      '3. 核对多条件的“且/或”、规则顺序、是否停止后续处理、归档与保留收件箱行为。',
      '4. 保存前用匹配和不匹配的测试邮件验证；确认后才启用，并保留原始 Gmail 规则作为回退依据。',
      '', '### 注意事项', `- 转换状态：${['converted', 'approximate', 'skipped'].includes(result.status) ? result.status : '未知，需人工复核'}。`,
      ...(issues.length ? issues.map(issue => `- ${issue}`) : ['- 无转换诊断不代表目标兼容，仍须人工测试。']),
      '- skipped 或 approximate 规则必须逐项解决问题；无法迁移时明确记录，绝不静默丢弃。');
  }
  return lines.join('\n') + '\n';
}
