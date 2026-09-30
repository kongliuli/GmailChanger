# 账号清点与多邮箱接入 · 设计与调研(草案)

状态：P1–P4 已在 feat/account-inventory 分支实现（账号清点模式、EML 输入、改绑链接种子库、导入来源文档）；本文与实现不一致时以代码为准。
所属分支:`feat/account-inventory`;不改动 0.1.x 维护线的安全边界。

## 1. 背景与威胁模型

HN 帖 [Discontinuation of third level domain registrations for the .name TLD](https://news.ycombinator.com/item?id=49516047):约 22000 个三级域名将于 2027-02-15 终止,评论区典型发言:"I've had mine for over 20 years, so the number of services I've registered under that email are endless"、"90 days to transition is an extremely short period of time to transition literally every account I have"。维护者另引述一张更高热度(约 2230 分)的帖子与"根本没办法列出这个邮箱注册过的所有账号"的原话;**该帖未能精确核实**,本文仅采信已核实链接的内容,结论不受影响。

威胁模型:旧地址失效或被他人注册后,对方可对任意"用该邮箱注册且未改绑"的账号发起**找回密码接管**。缓解手段只有一个——完整清点并逐一改绑。清点本身没有任何邮箱服务商提供;邮件归档是唯一全面的线索源。

与 GmailChanger 的关系:同一批输入(Takeout MBOX)、同一解析内核、同一本地隐私边界。做成现有工具的一个模式,比为独立产品再建一套信任与分发更划算。

## 2. 调研结论

### 2.1 竞品空白(2026-09 核实)

| 方案 | 数据源 | 本地性 | 结论 |
|---|---|---|---|
| Mine(saymine.com)、unroll.me、Clean Email | 云端读你全部邮件 | ❌ | 隐私代价不可接受,与本项目不变量冲突 |
| HIBP / Firefox Monitor | 泄露库 | ❌(查询式) | 只覆盖"泄露过的服务",不是注册清单 |
| DIY 脚本(Python `mailbox` + grep) | 本地 | ✅ | 无产品化、无分类置信度、无改绑链接 |
| **本地开源清点工具** | — | — | **未找到。空白确认。** |

### 2.2 改绑链接数据

- [JustDeleteMe](https://justdeleteme.xyz)(删号链接,crowdsourced `sites.json`)与 [JustGetMyData](https://justgetmydata.com)(数据导出链接,JDM 的 fork)证明"众包链接库"模式可行。
- **两者都没有"更改账户邮箱"链接库**——这是我们的差异化资产:`src/data/change-email.js` 自建种子(首批 50–100 个常用服务),社区 PR 扩充。若借鉴 JDM 数据,引入前须核验其数据许可证。

### 2.3 导出格式矩阵(多邮箱接入的输入面)

| 来源 | 官方导出形态 | 结论 |
|---|---|---|
| Gmail Takeout | MBOX | 已支持 |
| Apple Mail | `Export Mailbox` → .mbox | MBOX 路径直接可用 |
| Thunderbird | mbox 存储 + ImportExportTools NG(mbox/EML) | 可用;EML 需新增支持 |
| Fastmail | "Download all your data" zip(含 mbox);单邮件 raw .eml | 需 EML 支持 |
| Proton | 官方导出 = **逐邮件 EML + JSON 元数据**;mbox 须绕道 Bridge/Thunderbird | **EML 是必选项**,否则 Proton 用户无法使用 |
| Outlook.com | 无浏览器直导;须经 IMAP 客户端或 PST | 只做手动路径文档,不做解析承诺 |

技术结论:新增 **RFC822 单邮件 `.eml` 输入**(文件/文件夹/ZIP 均可),与现有 MBOX 共用同一套头解析与去重(Message-ID 跨文件去重协议已实现)。"网页版"指 `dist` 根目录的静态网页形态——extension 与网页共享同一构建产物,网页版作为一等分发目标意味着 EML/mbox 多邮箱能力在两种形态下都可用。

## 3. 目标与非目标

**目标**

1. 账号清点模式:本地扫描邮件归档,按服务聚合"有账号证据"的邮件,导出 `accounts.csv` / `accounts.md`(含首次/最近证据、证据类别、样本 Message-ID、改绑链接或"未收录")。
2. 多邮箱导入:`.eml` + `.mbox`,覆盖 Gmail/Apple/Thunderbird/Fastmail/Proton 的官方导出。
3. 改绑链接种子库,本地打包,运行时零网络。
4. 网页版(非扩展)与扩展同能力。

**非目标(不可破坏的不变量,继承自 0.1.x)**

- 不登录任何邮箱、不做 IMAP 拉取、不做 OAuth;不自动发送任何邮件(包括取消订阅)。
- 无网络请求/遥测;链接是纯展示的 URL,由用户手动点击。
- **不声称清单完整**:分类有误报/漏报,输出必须展示"未分类"与置信信号,由用户人工复核。
- 不解析、不存储、不导出邮件正文内容(仅头部与主题行)。

## 4. 方案设计

### 4.1 分类器(`src/accounts.js`,纯函数,可单测)

对每封邮件输出一个证据类别(保守优先,存疑归"未知"):

| 信号 | 头字段 | 示例 |
|---|---|---|
| 事务性特征 | `Auto-Submitted: auto-*`、`Precedence: bulk/junk`、`X-Auto-Response-Suppress`、无 `List-Unsubscribe` | 区分营销邮件与系统邮件 |
| 主题模式(多语言) | 注册/欢迎/验证/确认/收据/发票/找回密码/两步验证码 | `welcome`, `confirm your`, `验证`, `登録`, `bestätigen` |
| 验证码形状 | 主题或正文前 N 字节的短数字/字母码模板 | `123456 is your code` |

聚合键 = 发件域(规范化小写)。每域产出:证据类别计数、首/末证据日期、样本 Message-ID 列表(≤3)。**营销/通讯类邮件(List-Unsubscribe 存在且无事务信号)单独归"mailing-list"桶,不计入账号证据**——这是防误报的关键边界。

### 4.2 输出

- `accounts.csv`:域、显示名、类别计数、首/末日期、改绑链接状态。
- `accounts.md`:人读报告,按"有账号证据 / 仅通讯 / 未分类"分节,逐条附改绑链接(来自种子库)或"未收录——请手动查找"。
- 复用现有 CSV 公式防护与转义。

### 4.3 UI 集成

第 1 步(选择目标)增加**模式切换:迁移模式 / 清点模式**。导入步骤完全共用;Review 与导出步骤按模式渲染(清点模式:账号表 + accounts 导出;迁移模式:现有五步内容不变)。理由:两种用户旅程输入相同、信任边界相同,但输出与话术完全不同,共享导入内核而分流呈现。

### 4.4 性能与内存

沿用现有边界:流式、只聚合不存正文、Message-ID 去重 100000 上限、Worker 承担解析。新增:每域聚合记录为 O(域数),超上限(如 50000 域)截断并警告。

## 5. 分阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 分类器 + `accounts.csv/md` 导出(Gmail mbox 即可用) | Node 单测覆盖分类信号与聚合;扩展冒烟含清点模式 |
| P2 | 改绑链接种子库 + 清点 Review 面板 | 链接库有校验脚本(死链/格式);UI 双语 |
| P3 | `.eml` 输入(文件/夹/ZIP) | Proton/Thunderbird 形态夹具测试;跨邮箱去重 |
| P4 | Outlook.com 手动路径文档;网页版分发说明 | 文档 |

每个阶段独立可发布、独立可回退;P1 不含链接库也可用。

## 6. 风险与开放问题

1. **误报/漏报是常态**:老归档、转发链、多语言、改名服务。缓解:证据分级展示 + "未分类"显式呈现 + 报告开头声明不完整性。
2. 输出含发件域与日期(低敏 PII),沿用"导出文件用户自行保管"原则。
3. 种子库维护成本:接受长尾"未收录",宁可留空不编造链接。
4. 维护者引述的 2230 分原帖未核实(见 §1);如后续找到原链再补。
5. "多邮箱网页版的接入"本设计按 §2.3 的理解展开(多服务商导出导入 + 网页版一等目标);如维护者本意是其他形态(如 IMAP 拉取),与不变量冲突,须重议。
