# GmailChanger

版本 0.1.1 · Beta · Manifest V3 浏览器扩展 · 100% 免费开源（MIT）

一个免费、开源、全程本地运行的 Gmail **迁移配置助手**。它不会登录邮箱，不会上传邮件，**不会迁移或搬运邮件**。

## 能做什么 / 不能做什么

- 将 Gmail `mailFilters.xml` **保守转换**成通用 Sieve，并显示已转换 / 近似 / 已跳过。
- 无法安全转换的规则写入 `gaps.md`；不支持的有效字段跳过整条规则，近似规则默认**整段注释禁用**。
- 流式分析 MBOX 的必要邮件头，规划标签对应的文件夹；仅从 Sent / 已发送线索中分析历史发件地址候选。
- 接受 XML、MBOX、受限 ZIP，或已解压文件夹；由 Web Worker 分担解包与分析。
- 本地导出 `rules.sieve`、`folders.json`、`senders.csv`、`gaps.md`。

**不做：**邮件传输、IMAP 上传、Gmail/目标邮箱登录、自动创建文件夹、自动修改或启用邮箱规则、自动配置发信身份。不支持 TGZ 或 Outlook `.rwz`；不是完整 Gmail 查询语言/MIME 解析器。历史发件地址不是经验证的账号或权限清单。

ZIP 上限为 **512 MiB 输入、128 MiB 单项、256 MiB 接受条目的总展开量、2000 个接受条目**。不安全/不支持的 ZIP 会拒绝，不能保证任意 Takeout ZIP 直接可读；只提取 XML/MBOX，其他安全条目忽略，目录损坏或边界无法确认则拒绝整个包。大型导出请先在本地解压，再选 XML/MBOX 或文件夹。

Message-ID 去重每个集合最多 **100000** 个。底层 `analyzeMailbox` 已接受调用方提供的共享 `seen` 集合；近期导入流程计划在**同一次导入批次**的所有 MBOX 间共享该集合，并在“清空/重置”时丢弃它。Worker 侧批次共享协议仍在实现，因此当前界面不应被描述为已经保证跨 MBOX 去重。缺失 ID、超上限及文件重叠仍会影响数量，请阅读警告。

## 用户安装

可从 [GitHub Releases](https://github.com/kongliuli/GmailChanger/releases) 获取 ZIP，或按下文自行构建。构建产生 `dist/chrome`、`dist/firefox`、`dist/GmailChanger-chrome.zip`、`dist/GmailChanger-firefox.zip`；Edge 使用 Chrome 构建。

### Chrome / Edge：加载已解压扩展

1. 解压 `GmailChanger-chrome.zip` 到固定目录，或执行 `npm run build` 后使用 `dist/chrome`。
2. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
3. 开启“开发者模式”，选择“加载已解压的扩展程序”。
4. 选择含 `manifest.json` 的目录（不是 ZIP 文件，也不是整个项目根目录）。
5. 点击扩展图标打开应用页。更新构建后在扩展管理页重新加载。

### Firefox：临时加载

1. 解压 `GmailChanger-firefox.zip`，或使用构建后的 `dist/firefox`。
2. 打开 `about:debugging#/runtime/this-firefox`。
3. 选择“临时载入附加组件”，选择该目录下的 `manifest.json`。
4. 点击扩展图标打开应用页。临时加载通常随浏览器重启失效。

普通发行版 Firefox 的长期安装通常要求 Mozilla 签名；维护者需要通过 Firefox Add-ons 的签名/发布流程。这里的 ZIP 不是已签名商店包。**开发期间未启动 Firefox，生成 Firefox 包不代表完成 Firefox 运行验证。**

## 使用流程

界面使用五步向导。中文步骤名依次为 **1 选择目标、2 导入数据、3 检查转换、4 文件夹映射、5 导出结果**；英文依次为 **Target、Import、Review、Folders、Export**。

1. **选择目标 / Target：**选择或确认目标服务商；这只影响候选能力检查和输出方式，不会登录目标邮箱。
2. **导入数据 / Import：**Gmail 设置 →“过滤器和被屏蔽的地址”→ 导出 `mailFilters.xml`；如需标签和历史发件地址，通过 Google Takeout 导出 Gmail。选择 XML、MBOX、ZIP 或已解压文件夹，等待本地分析并查看警告。取消时不要把部分完成结果当作完整迁移结果。
3. **检查转换 / Review：**阅读“已转换 / 近似 / 已跳过”和“需人工检查”。近似规则默认不运行；不要未经检查批量取消注释。
4. **文件夹映射 / Folders：**确认标签映射、重名/层级提示与历史发件地址候选，手动验证目标服务商的文件夹及发信权限。
5. **导出结果 / Export：**下载所需结果，先阅读 `gaps.md`；生成的是配置建议，不包含搬运后的邮件。
6. **在目标邮箱手动测试和启用：**先备份现有规则，再用合成测试信核对命中、不命中、交叉命中、收件箱保留和转发副本。Outlook/Yahoo 走手动重建路径，不导入 Sieve。

详见 [支持规则](docs/supported-rules.md)、[目标服务商](docs/target-providers.md)。

## 规则矩阵摘要

| 分类 | 当前处理 |
|---|---|
| 单个精确 from/to 地址、合法大小比较 | 可转换为受限 Sieve 条件 |
| 单地址转发、查询内单地址/大小子集 | 受目标能力限制；必须核对转发和规则交互 |
| label、已读/星标、纯文本 subject、Archive、Trash | 近似，默认注释禁用；目标不支持的动作整条跳过，Trash 不生成永久删除 |
| 多条有效规则且任一涉及投递/转发 | 全部有效规则降为近似，默认禁用 |
| 超出受限子集的 Gmail 查询、附件条件、excludeChats、never spam、重要性、smart label、未知字段 | 跳过整条规则 |
| 无条件、非法地址/大小、控制字符、歧义动作组合 | 跳过整条规则 |

`generic`、`fastmail`、`proton` 共享编译语法，但候选能力白名单不同（例如 generic 不允许 flags，Proton 不允许 redirect）；这些白名单不是兼容认证。Outlook/Yahoo 不输出可执行 Sieve。精确边界请看完整矩阵。

## 隐私与安全

- 无 `host_permissions`、后端、运行时网络请求、遥测或账号。
- 文件在本机浏览器处理，扩展不加载邮件 HTML 或远程资源；浏览器商店自身行为不由本项目控制。
- MBOX 流式扫描，正文不会作为结果保存；读取流会经过正文，并非完全不读取正文的字节。
- 预览转义，CSV 对公式开头做防护；导出文件仍可能包含地址/标签，请保存在安全位置，不要直接公开。
- 关闭页面会释放当前内存状态；下载到磁盘的文件需要你自行管理。

详见 [隐私政策](PRIVACY.md) 和 [安全说明](SECURITY.md)。

## 本地开发

Node.js 20+：

```sh
npm install
npm run dev
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run check
```

`npm run dev` 启动本地开发网页；扩展安装仍需 build 后加载目录。Playwright 首次需安装 Chromium。`npm run check` 依次执行 Node 测试、构建、浏览器测试和包校验。CI 用 `npm ci`、Node 测试与构建；CI 绿色不代表已跑浏览器或真实服务商测试。

## 项目布局

```text
src/main.js       界面、状态与导入编排
src/filters.js    XML 模型与保守 Sieve 转换
src/imports.js    输入识别、受限 ZIP、DOMParser 入口
src/mailbox.js    流式 MBOX 邮件头分析、文件夹规划
src/worker.js     Web Worker 边界
src/exports.js    本地下载、CSV 与缺口报告
public/           扩展静态资源
scripts/          双浏览器打包、ZIP 与包验证
tests/            Node 单测及 Playwright Chromium 检查
docs/             架构、规则、服务商、测试数据和发布说明
.github/          CI、标签发布与贡献模板
```

[CONTRIBUTING.md](CONTRIBUTING.md) · [架构](docs/architecture.md) · [发布](docs/release.md) · [CHANGELOG](CHANGELOG.md)。早期 [设计文档](docs/gmail-migration-extension-design.md) **已废弃（obsolete）**，仅供历史参考，不是当前功能承诺；TGZ、自动迁移、商店上线和“直接兼容”等描述不应作为当前状态依据。

## 验证状态

0.1.1 已验证基线：**157 个 Node 测试中 156 个通过、1 个浏览器原生 DOMParser 单元测试在 Node 中跳过**；相关 XML 解析由 Playwright 浏览器测试覆盖。测试数量会随新增用例变化，请以本次命令输出为准。

- Playwright 使用 Chromium 验证 DOMParser、页面导入和权限声明；不是完整跨浏览器/商店测试。
- **Fastmail/Proton 未使用真实账号验证兼容性。**
- **Firefox 在开发期间没有启动。** 包构建/静态检查不能替代运行测试。
- Beta 输出必须人工复核；无已知缺口不等于没有问题。

## English summary

GmailChanger 0.1.1 is a beta, Manifest V3, local-only **configuration assistant, not a mail migration tool**. It conservatively converts Gmail filter XML to Sieve, analyzes MBOX headers for folder plans and sent-address candidates, and exports four local reports. Unsupported active fields skip the whole rule; approximate rules are **commented out by default**.

No mail transfer, IMAP upload, TGZ, Outlook `.rwz`, host permissions, runtime network requests, telemetry or accounts. ZIP limits: 512 MiB input, 128 MiB per entry, 256 MiB accepted expanded data and 2000 accepted entries; unsafe archives are rejected. Message-ID sets are capped at 100000. The analyzer API accepts a shared `seen` set; per-import-batch sharing and reset behavior are planned while the Worker protocol is still being implemented, so the current UI does not yet guarantee cross-MBOX deduplication.

Build with `npm install` and `npm run build`; load `dist/chrome` unpacked in Chrome/Edge or temporarily load `dist/firefox/manifest.json` via Firefox `about:debugging`. Both ZIPs are under `dist/`; Firefox permanent distribution normally needs signing. Export Gmail XML/Takeout locally, import, review every rule/folder/sender and gap, then export and manually test in the target mailbox. Outlook/Yahoo require manual rule reconstruction.

Recorded baseline: 30 Node tests passed; one native DOMParser unit test is skipped in Node and covered by Playwright browser checks. **No real-account Fastmail/Proton compatibility tests; Firefox was not launched during development.** Generic/Fastmail/Proton share compiler syntax but have different conservative capability allowlists, not certified adapters.

100% free and MIT open source; no paid tier, feature gating, donations or payment integration of any kind. Run `npm run check` before contributing; never share real email data in reports.

## 许可证

MIT，见 [LICENSE](LICENSE)。
