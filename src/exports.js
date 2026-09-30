import { getTarget, defaultFolders } from './targets.js';

function safeCsv(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function stamp() { return new Date().toISOString(); }

/** Senders may carry optional confidence/sources; extra columns stay empty when unknown. */
export function sendersCsv(senders) {
  const rows = senders.map(item => [safeCsv(item.email), item.count, safeCsv(item.confidence || ''), safeCsv((item.sources || []).join(' '))].join(','));
  return '\uFEFF地址,邮件数量,置信度,来源\r\n' + rows.join('\r\n');
}

export function foldersJson(folders, { target = 'generic', archiveFolder, trashFolder } = {}) {
  const profile = getTarget(target);
  const defaults = defaultFolders(profile);
  archiveFolder ??= defaults.archiveFolder;
  trashFolder ??= defaults.trashFolder;
  return JSON.stringify({
    version: 1, generatedAt: stamp(), target: profile.id, targetLabel: profile.label,
    targetVerifyStatus: profile.verifyStatus,
    archiveFolder, trashFolder,
    folders: folders.filter(item => item.folder).map(item => ({
      gmailLabel: item.label, targetFolder: item.folder, create: true, notes: item.notes || [],
    })),
    omitted: folders.filter(item => !item.folder).map(item => ({ gmailLabel: item.label, notes: item.notes || [] })),
    notes: profile.notes,
  }, null, 2);
}

export function gapsMarkdown(gaps, results, { target = 'generic' } = {}) {
  const profile = getTarget(target);
  const disabled = results.filter(item => item.status === 'approximate').length;
  return `# GmailChanger 转换缺口\n\n生成时间：${stamp()}\n目标：${profile.label}（兼容性状态：${profile.verifyStatus}）\n\n> 本报告列出未转换、近似转换与被禁用规则。请在启用前逐项检查。\n\n## 汇总\n\n- 规则总数：${results.length}\n- 精确转换：${results.filter(item => item.status === 'converted').length}\n- 近似（默认禁用，需人工启用）：${disabled}\n- 已跳过：${results.filter(item => item.status === 'skipped').length}\n\n## 目标服务商注意事项\n\n${profile.notes.map(note => `- ${note}`).join('\n')}\n\n## 详情\n\n${gaps.length ? gaps.map((gap, index) => `${index + 1}. ${gap}`).join('\n') : '没有已知缺口。仍建议在目标邮箱中用测试邮件验证后再启用。'}\n`;
}

/** Human guide shipped alongside the machine-readable files. */
export function migrationReadme({ target = 'generic', files = [], results = [], folders = [], senders = [], warnings = [], archiveFolder, trashFolder } = {}) {
  const profile = getTarget(target);
  const defaults = defaultFolders(profile);
  const { reserved } = defaults;
  archiveFolder ??= defaults.archiveFolder;
  trashFolder ??= defaults.trashFolder;
  const active = results.filter(item => item.status === 'converted').length;
  const disabled = results.filter(item => item.status === 'approximate').length;
  return `# Gmail 迁移操作指南

生成时间：${stamp()}
目标服务商：${profile.label}
兼容性状态：${profile.verifyStatus === 'unverified' ? '未在真实账户验证，请自行核对' : profile.verifyStatus}

## 一、本次生成的文件

${files.map(file => `- \`${file.name}\`：${file.purpose}`).join('\n')}

## 二、迁移前必须知道的事

- 本工具只转换**配置**，不搬运邮件、联系人或日历。
- 不登录你的邮箱，不上传任何数据，也不修改目标邮箱。
- ${profile.kind === 'recipe' ? '该服务商没有可导入的规则文件，请按手工配方逐条重建。' : '生成的脚本请在目标邮箱的 Sieve 编辑器中检查后再启用。'}
- 精确转换 ${active} 条；近似且默认被注释禁用 ${disabled} 条；其余见 \`gaps.md\`。

## 三、先在目标邮箱建好文件夹

需要创建的文件夹（层级按 \`/\` 分隔）：

${folders.filter(item => item.folder).map(item => `- ${item.folder}${item.notes?.length ? `（提示：${item.notes.join('；')}）` : ''}`).join('\n') || '- （本次没有从邮件数据得到用户文件夹；如规则里引用了标签，请按 gaps.md 手工确认）'}

归档文件夹：\`${archiveFolder}\`
垃圾箱文件夹：\`${trashFolder}\`
请避免使用服务商保留名称：${reserved.join('、')}

## 四、启用规则

1. 打开目标邮箱的过滤器 / Sieve 设置。
2. ${profile.kind === 'recipe' ? '按手工配方逐条创建，不要跳过无法表达的条件。' : '粘贴 `rules.sieve`，检查是否有语法或扩展报错。'}
3. 先用测试邮件验证：分别发一封**应匹配**和**不应匹配**的邮件。
4. 确认无误后再启用；保留本目录文件，便于回退。

## 五、还要手工处理的部分

- 历史发件地址见 \`senders.csv\`。这些是**候选**，不是 Gmail「以身份发送」的完整配置；SMTP 主机、密码与验证状态无法从邮件历史恢复。
- 被注释禁用的近似规则需要你逐条确认语义后再启用。
- 「永不进入垃圾邮件」「重要性标记」等 Gmail 专有行为没有等价项，需要在新邮箱手工调整。

## 六、本次导入提示

${warnings.length ? warnings.map(warning => `- ${warning}`).join('\n') : '- 无额外提示。'}
`;
}

export function downloadText(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
