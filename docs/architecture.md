# 架构与安全边界

当前实现为 JavaScript + Vite 的 Manifest V3 本地扩展；不是已废弃设计稿中的 TypeScript/CRXJS/TGZ 方案。业务状态在扩展页面内存中，未使用后端、账号、遥测或 IndexedDB 持久化。本文明确区分已存在代码与近期计划 UI。

## 模块图

| 模块 | 职责 |
|---|---|
| `public/manifest.json`、`public/background.js` | 最小扩展壳；点击图标打开应用页，无 host_permissions |
| `src/main.js` | UI、导入队列、取消、状态合并、预览、转换和导出编排 |
| `src/imports.js` | XML/MBOX/EML/ZIP/文件夹输入识别、受限 ZIP 检查/解包，主线程 DOMParser 包装 |
| `src/filters.js` | XML Document → 规则模型 → Sieve、逐条状态与缺口；严格字段白名单 |
| `src/query.js` | 原子解析受限查询；转换器仍拒绝不能保守编译的谓词 |
| `src/targets.js` | 未经实测的候选能力白名单、默认文件夹与人读配方 |
| `src/mailbox.js` | Blob 流扫描，必要邮件头、Sent 候选统计、标签与文件夹映射 |
| `src/accounts.js` | 账号证据分类（仅邮件头与主题）、按发件域聚合、改绑链接查找 |
| `src/data/change-email.js` | 本地打包的改绑邮箱链接种子库；无稳定深层 URL 的条目只写说明 |
| `src/worker.js` | 处理解包/分析消息，回传进度、结果或错误 |
| `src/exports.js` | CSV、Markdown、Blob 下载，不向服务器发送结果 |
| `scripts/package.mjs` / `archive.mjs` | Chrome/Firefox 布局与两个 ZIP |
| `scripts/verify-packages.mjs` | 检查权限、manifest 和 ZIP 必需内容 |

## 数据流

```text
用户主动选文件 / 文件夹
  → Worker：识别、ZIP 边界检查与解包
  → XML：页面 DOMParser → parseFilters → 内存规则
  → MBOX/EML：Worker 流式邮件头分析 → 标签、候选、警告与账号证据
  → 账号证据：按发件域聚合（有账号证据 / 仅通讯 / 未分类）
  → buildFolders → folderMap
  → convertFilters → Sieve、状态、缺口
  → 页面人工预览 → Blob 本地下载
```

文件夹选择只提供用户授权的文件列表，不扫描任意磁盘。XML 在页面用浏览器原生 DOMParser 处理，Worker 不代替 DOM。MBOX 流经过正文，但不生成邮件正文模型、不渲染 HTML、不解析远程资源；输出只是统计/配置建议。

## 当前 UI

当前 `src/main.js` 已实现五步向导单页界面，固定标签为：**目标 → 导入 → 检查 → 文件夹 → 导出**。该展示与流程编排不改变本地处理、保守转换或人工启用边界。第一步可在**迁移配置**与**账号清点**两种模式间切换：两种模式共用导入步骤与全部本地边界；清点模式提供独立的检查与导出面板，不使用文件夹映射与目标服务商选择。\n\n## Worker 边界

页面把 File/Blob、来源路径和必要选项传给模块 Worker；Worker 返回可结构化克隆的结果与进度，异常转换成错误文本。Worker 的用途是减少主线程阻塞，不是邮箱服务端，也不是持久后台任务。页面取消/结束任务时终止相应 Worker，关闭页面不继续迁移。MV3 扩展后台与负责解析的 Web Worker 是两个概念。

当前底层 `analyzeMailbox` 的 `seen` 是调用方拥有的共享集合。只有调用方跨文件保存/复用它，跨 MBOX 发件候选才去重；不能假定每次新建 Worker 自动共享内存。**Worker 侧跨文件协议仍在实现。** 目标行为是在同一次导入批次内共享一个 `seen` 集合，“清空/重置”时丢弃并新建集合；不同批次不隐式沿用旧状态。完成该协议前，当前 UI 不保证跨 MBOX 去重。账号证据的跨文件去重使用另一个调用方集合 `evidenceSeen`：同一导入批次内按 Message-ID 去重，“清空/重置”时丢弃，同样受 100000 上限约束。

每个 Message-ID 集合最多 100000 个，后续未跟踪 ID、无效/缺失 ID 会影响计数。物理邮件计数不因发件统计去重而减少，标签仍合并。

## 失败处理

- ZIP 在解包前检查目录及声明大小；无法安全支持的包返回警告并不导入。用户可解压后选相关文件。ZIP 非流式全量导入，不把其大小限制描述为任意大邮箱支持。
- XML 格式、DOCTYPE、根节点不合格时拒绝文件；重复/未知属性等导致具体规则被跳过。不支持的查询绝不通过丢弃条件来“修复”。
- MBOX 畸形头/超限头跳过相关统计并警告；不靠猜测增加发件身份。
- 文件失败或取消应提示用户，已完成文件结果可能保留；部分结果不等于全批成功。重新导入前按界面清空或确认当前状态。
- 复制失败可改为下载。导出文件包含用户数据，用户负责保管；关闭页面不会删除已下载文件。

## 不可破坏的安全不变量

1. 无网络请求、账号、遥测、后端和 host_permissions；不自动操作邮箱。
2. 不支持的有效条件/动作跳过**整条**规则，不静默扩大匹配范围。
3. 近似规则默认整段注释；多规则投递/标记交互不能宣称等价。`includeApproximate` 只允许显式选择启用。
4. 不生成 `discard`，不自动删除/搬运邮件；Archive/Trash 只是文件夹名，必须人工检查。
5. ZIP 限额：512 MiB 输入、128 MiB 单项、256 MiB 接受条目总展开量、2000 接受条目；不支持 TGZ、ZIP64 等无法安全支持的输入。实际拒绝条件以 `imports.js` 为准。
6. MBOX 行/头边界为 64 KiB/256 KiB（以解码字符衡量），去重集合 100000 上限；不承诺恒定总内存，标签和候选数量也占内存。
7. 不可信文本预览需转义，Sieve 字符串需引用/转义并拒绝控制字符，CSV 需防公式前缀；诊断数据也可能含隐私。
8. 来信 From 不代表用户发信身份；仅 Sent 线索统计仍只是候选。
9. 无付费层/功能门槛/捐赠或支付集成，不埋点。
10. 账号清点只读邮件头与主题行；营销通讯（有 List-Unsubscribe 且无事务头）不计入账号证据；“欢迎”类主题在通讯特征存在时降级为通讯。清单显式声明不完整，改绑链接只来自本地种子库，未收录即如实标注，不编造。

## 验证边界

Node 测试覆盖纯转换、MBOX 和输入路径；浏览器原生 DOMParser 相关检查由 Playwright Chromium 执行。包校验只验证静态产物，不证明 Firefox 已运行，也不证明 Fastmail/Proton 实际账号兼容。基线和命令见 [README](../README.md)，具体映射见 [supported-rules](supported-rules.md)。
