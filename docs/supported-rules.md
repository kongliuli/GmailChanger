# 支持的规则（0.1.0）

以 `src/filters.js` 为准。精确仅指当前受限转换模型，并非服务商兼容认证。**任何不支持的有效条件或动作都会跳过整条规则**；不是删除该条件后继续转换。近似规则默认整段注释，不会执行。

## 条件 → Sieve

| Gmail 字段 | Sieve / 要求 | 精确 | 近似 | 跳过 |
|---|---|---|---|---|
| `from` | `address :is "from" "地址"`；单个 ASCII dot-atom 邮箱、DNS 风格域名 | ✓ | — | 显示名、列表、通配符、搜索语法、空白包围等 |
| `to` | `address :is "to" "地址"`；同上，不扩展到 Cc/Bcc | ✓ | — | 同上 |
| `subject` | `header :contains "subject" "文本"` | — | ✓，子串不同于 Gmail 分词 | 非允许的纯文本或搜索运算符 |
| `size` + `sizeOperator` + `sizeUnit` | `size :over N` / `size :under N` | ✓ | — | 非整数、未知单位/运算符、越界或缺少配套字段 |
| `hasTheWord` | 受限查询子集，见下表；隐式 AND | 单地址/大小 | subject 子串 | 其他任何查询谓词 |
| `doesNotHaveTheWord` | 对上述整个 AND 表达式加 `not`，保留内部前导负号语义 | 单地址/大小 | subject 子串 | 其他任何查询谓词 |
| `hasAttachment=true` | 不猜测 MIME 附件 | — | — | ✓ |
| `excludeChats=true` | 无实现 | — | — | ✓ |

`subject` 必须以 Unicode 字母或数字开头，后续仅允许字母、数字、空格及 `.,_'!?@&%-`；独立大写 `OR`、`AND`、`NOT` 被拒绝。引号、括号、冒号和通配符不支持。

大小单位：`s_sb` ×1、`s_skb` ×1024、`s_smb` ×1048576；运算符 `s_sl` → `:over`、`s_ss` → `:under`。结果须为 0–4294967295 的安全整数字节数。没有 `size` 时，`sizeOperator` / `sizeUnit` 是不生效的 UI 元数据，不构成条件。多个有效条件使用 `allof`；不生成无条件规则。

## 查询子集（`hasTheWord` / `doesNotHaveTheWord`）

| 查询形式 | Sieve | 状态 |
|---|---|---|
| `from:a@example.com`、`to:...`、`cc:...` | `address :is` 对应头字段 | 精确受限地址；查询会将地址小写 |
| `larger:2K`、`size:2K` | `size :over 2048` | 精确；size 在此也是大于，不是等于 |
| `smaller:2M` | `size :under 2097152` | 精确 |
| `subject:文本`、`subject:"多个 单词"` | `header :contains "subject" ...` | 近似，默认禁用 |
| `-from:...` 等单个前导减号 | `not` 对应测试 | 保留否定，状态跟随内部测试 |
| 裸词/正文、地址子串、`has:attachment` | 即使查询解析器可识别，转换器也不编译 | 整条跳过 |
| OR、括号/大括号、通配符、label/in/is/list/filename/bcc/日期等 | 不支持 | 整条跳过 |

查询限 4096 字符、20 词元；支持隐式 AND，不支持显式 OR（即使两边相同）。大小支持字节或 K/M/G，仍限 32 位字节范围。引号内仅允许转义双引号和反斜杠；未知、矛盾或不能编译的任意谓词使整条失败，不能忽略后继续。

## 动作 → Sieve

| Gmail 字段 | Sieve / 行为 | 精确 | 近似 | 跳过 |
|---|---|---|---|---|
| `label` | `fileinto "映射文件夹";`；不归档时追加 `keep;` 保留收件箱 | — | ✓，文件副本不等同 Gmail 标签 | 无效目的文件夹或目标能力不足 |
| `shouldArchive=true` | 有 label 时投递到该文件夹，否则 `fileinto "Archive";`；无 Inbox keep | — | ✓ | 与 Trash 冲突 |
| `shouldMarkAsRead=true` | `addflag "\\Seen";`，需要 `imap4flags` | — | ✓，累积标记语义需核对 | 目标不支持 imap4flags |
| `shouldStar=true` | `addflag "\\Flagged";`，需要 `imap4flags` | — | ✓，累积标记语义需核对 | 目标不支持 imap4flags |
| `shouldTrash=true` | `fileinto "Trash";`；绝不生成 `discard` | — | ✓ | 与 label / Archive 冲突 |
| `forwardTo` | `redirect "地址";`；无 fileinto 时追加 `keep;`，否则保留文件夹副本 | ✓* | 多规则交互时 | 非单个合法邮箱 |
| `shouldNeverSpam=true` | 不转换（不是 `keep` 的同义词） | — | — | ✓ |
| `shouldAlwaysMarkAsImportant=true` | 不转换 | — | — | ✓ |
| `shouldNeverMarkAsImportant=true` | 不转换 | — | — | ✓ |
| `smartLabelToApply` | 不猜测分类对应文件夹 | — | — | ✓ |

`fileinto` 动作需要 `fileinto` 扩展。文件夹由 `folderMap` 映射，Archive/Trash 只是约定名称，不做服务商特殊文件夹查找；必须手动建好。标记动作在投递动作之前输出。

\* 如果有两条或更多未跳过规则，且其中任一包含 label、Archive、Trash 或转发，**所有未跳过规则都降为近似**：实现不证明规则互斥，也不模拟 Gmail 累积投递/标记语义。不生成 `stop`，同一邮件可能匹配多条规则并产生额外副本。标记动作本身也标为近似；generic 默认不允许 imap4flags，相关规则跳过。

## 永不转换与安全边界

- 有效的 `hasAttachment`、`excludeChats`、`shouldNeverSpam`、`shouldAlwaysMarkAsImportant`、`shouldNeverMarkAsImportant`、`smartLabelToApply`，以及任意未知字段：整条跳过。
- 已知字段空字符串、布尔开关 `false` 为不生效；布尔开关只接受 `true` / `false`（模型也接受对应布尔值），其他值跳过。未知字段即使为空或 false 也不被忽略。
- XML 必须为 Atom feed、正确的 apps 命名空间；DOCTYPE、解析错误或错误根节点拒绝整个 XML。重复属性、属性缺失/命名空间错误进入规则诊断并跳过该规则。Atom 标题、分类、时间等不是条件。
- 控制字符、无条件规则、无支持动作、非法映射、歧义投递组合均不生成活动规则。
- 默认 `includeApproximate=false`。开发 API 只有显式布尔 `true` 才启用近似规则；取消注释前要检查脚本的 `require`，因为默认输出仅为活动规则声明扩展。
- `generic` / `fastmail` / `proton` 共享编译语法，但 `targets.js` 候选能力白名单不同：generic 不允许 flags，Proton 不允许 redirect；能力缺失时即使开启近似也整条跳过。`outlook` / `yahoo` 为手动配方、不输出活动 Sieve。`unknown` 使用通用基线并标近似，未登记的 target ID 抛错。兼容性见 [目标服务商](target-providers.md)。
