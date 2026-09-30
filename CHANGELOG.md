# Changelog

采用 Keep a Changelog 的分区方式；版本遵循语义化版本。中文为主，`Unreleased` 表示尚未发布，不表示商店已经上架。

## [Unreleased]

## [0.1.1] - 2026-09-30

### Removed

- 移除捐赠/赞助功能：界面不再显示赞助面板，不再探测本地收款二维码；`public/donate/` 目录、构建复制与包校验逻辑一并删除。

### Fixed

- MBOX 标签的 RFC 2047 解码：相邻编码词解码后的逗号按标签分隔符处理；单个编码词内的逗号仍保留为标签文本。
- Unicode 替换字符警告只统计字节流解码引入的 U+FFFD，不再把编码词解码产物重复计入。
- 扩展冒烟测试与 `folders.json` 实际键名（`gmailLabel`）对齐。

### Changed

- 补充安装、规则边界、隐私、贡献、测试数据与手工发布说明。
- 添加 Node 20 CI 构建产物归档与标签发布工作流。

## [0.1.0] - 2026-09-29

### Added

- Manifest V3 本地 Gmail 配置助手：无账号、遥测、网络请求或 host_permissions。
- Gmail XML 的保守 Sieve 转换、规则状态和缺口报告；不支持的字段跳过整条规则，近似规则默认注释禁用。
- MBOX 流式邮件头分析、用户标签到文件夹规划，以及仅从已发送邮件推断的历史发件地址候选。
- XML、MBOX、受限 ZIP 与已解压文件夹输入，Worker 分担解包和分析工作。
- `rules.sieve`、`folders.json`、`senders.csv`、`gaps.md` 本地下载。
- Chrome/Edge、Firefox 构建目录与两个 ZIP 发布包，Node 单元测试及 Chromium/DOMParser 浏览器检查。

### Security

- ZIP 输入/展开大小与条目数限制，拒绝不安全或不能支持的归档；MBOX 头长度和 Message-ID 集合上限。
- 无永久删除 Sieve 动作，输出转义与 CSV 公式前缀防护。

### Known limitations

- Beta：不迁移邮件，不做 IMAP 上传、TGZ 或 Outlook `.rwz`。
- Fastmail/Proton 未通过真实账号兼容性测试；开发期间未启动 Firefox。构建成功不等于这些环境已经验证。
