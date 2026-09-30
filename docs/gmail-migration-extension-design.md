# Gmail 搬家工具 · 浏览器扩展 设计文档（v1，已废弃）

> **已废弃 / OBSOLETE：仅保留作历史背景，不是当前架构、功能、兼容性、发布状态或路线图。** 当前事实以仓库源码、[README](../README.md)、[架构](architecture.md) 与 [支持规则](supported-rules.md) 为准。本文中的 TGZ、TypeScript/CRXJS、自动迁移、商店上线、直接兼容和未来功能描述均不得作为产品承诺。

- 版本：v1
- 日期：2026-09-29
- 状态：**已废弃，仅供历史参考**
- 决策记录：做成浏览器扩展（Manifest V3），上架 Chrome + Firefox + Edge 三店同步；目标格式锁 Sieve（Fastmail / Proton 优先）。

---

## 1. 背景与问题

### 1.1 官宣事实（已核实，来源 Google 支持中心 `support.google.com/mail/answer/17101213`）

| 项 | 内容 |
|---|---|
| 生效时间 | **2027 年 1 月起** |
| 砍掉的功能 | ① 第三方地址「以身份发送 / Send mail as」 ② 网页版 Gmailify ③ 网页版 POP 代收 |
| 影响范围 | 网页版 **和** Gmail App（Android / iOS）均无法用 @outlook / @yahoo 等非 Gmail 地址发信 |
| 不受影响 | Gmail 别名之间、Google Workspace 的 Send mail as |
| 现状 | 2027-01 前已对新配置设限；移动端第三方账号添加仍可用 |
| 需求窗口 | 现在 → ~2026-12，约 3 个月持续需求（HN 相关帖 193 分，迁移意愿已被点燃） |

### 1.2 用户痛点

离开 Gmail 时，以下资产需要手工重建，且现有的转换工具大多已无人维护：

1. **过滤规则（Filters）** —— Gmail 的导出是私有 XML，别家邮箱读不了。
2. **标签（Labels）** —— Gmail 标签要变成别的邮箱的文件夹结构。
3. **常用发件地址（Send mail as）** —— 哪些第三方地址你实际在用来发信，必须逐个重配。

### 1.3 产品定位

> 一个**离线、本地**运行的浏览器扩展：读入 Google Takeout 导出，把过滤规则自动转成目标邮箱能用的格式（Sieve），把标签变成文件夹映射，并列出你平时实际在用的发件地址。

卖点：「2027 年 1 月前离开 Gmail——一键把过滤规则、标签、发件身份导出转好，全程本地不上传。」

---

## 2. MVP 范围

### 2.1 输入

- **邮件**：Google Takeout 导出 Gmail → `Takeout/Mail/<标签名>.mbox`（每个标签一个 mbox 文件，`All Mail` 为全集）。
- **过滤规则**：Gmail 设置 → 过滤器和被屏蔽的地址 → 底部「导出」→ `mailFilters.xml`（Atom feed + `apps:property`）。

> 注意：**「以身份发送」的地址清单不在任何 Takeout 导出里**，只能从邮件数据反推（见 7.4）。

### 2.2 输出（四个文件）

| 文件 | 内容 | 用途 |
|---|---|---|
| `rules.sieve` | Gmail 过滤规则转成的 Sieve 脚本 | 粘贴进 Fastmail / Proton 等支持 Sieve 的邮箱 |
| `folders.json` | 标签 → IMAP 文件夹的映射（含嵌套层级、去重建议） | 在目标邮箱建文件夹 / IMAP 上传参考 |
| `senders.csv` | 常用发件地址按使用频次排名 | 提示哪些第三方地址需重配 Send mail as |
| `gaps.md` | 无法精确转换的规则 / 字段清单 | 让用户知道哪些还要手工补 |

### 2.3 非目标（v1 不做）

- 不登录任何邮箱、不申请 Gmail `host_permissions`、不发任何网络请求。
- 不跨域自动粘贴 Sieve（浏览器安全限制）→ 改为「复制 + 深链打开目标邮箱 Sieve 编辑器」引导。
- 不做实时 Gmail API 抓取（离线优先，隐私优先）。
- 不做 IMAP 自动上传（作为后续 stretch，见第 10 节）。

---

## 3. 目标格式与商店支持矩阵

Sieve（RFC 5228）是覆盖面最广的通用过滤语言，作为 v1 的**唯一机器可读目标格式**。

| 目标服务商 | 规则导入方式 | 本工具产出 |
|---|---|---|
| Fastmail | **Sieve**（扩展极全） | `rules.sieve` 直接可用 ✅ |
| Proton（付费） | **Sieve**（fileinto / imap4flags） | `rules.sieve` 直接可用 ✅（免费版仅 1 条活跃过滤器） |
| mailbox.org / Posteo / 自托管 IMAP | **Sieve**（MANAGESIEVE） | `rules.sieve` 直接可用 ✅ |
| Outlook.com（消费者） | 无规则文件导入；仅网页 UI 或桌面 `.rwz` | 仅出「人读配方」 |
| Yahoo | 基础规则，无导入 | 仅出「人读配方」 |

> 对不支持 Sieve 的 Outlook / Yahoo，v1 在 `gaps.md` 或单独报告里给出「人读配方」（条件 + 动作的中文说明），引导用户在网页端手工建。

---

## 4. 整体架构（Manifest V3）

全流程在扩展页内完成，零网络：

```
[工具栏图标] → [扩展 App 页]
   ① 上传：.zip / .tgz / 已解压文件夹（file / webkitdirectory / 拖拽）
   ② 解包：fflate（gzip + tar + zip）
   ③ 解析：mbox 流式切分器 + DOMParser 读 mailFilters.xml
   ④ 模型：Filters / Labels / Senders 内存对象
   ⑤ 预览 UI：规则表 / 标签树 / 发件地址排名
   ⑥ 生成 + 导出：rules.sieve / folders.json / senders.csv / gaps.md（Blob 下载 + 复制按钮）
```

模块划分：

| 模块 | 职责 |
|---|---|
| `upload` | 接收文件 / 文件夹，识别 Takeout 结构 |
| `unpack` | fflate 解包，定位 `Mail/*.mbox` 与 `mailFilters.xml` |
| `mbox` | 按 `From ` 信封行切分，抽取 `From:` / `Subject:` / `Message-ID` 头 |
| `filters` | DOMParser 解析 filter XML → Filter 模型 |
| `model` | 统一内部模型 |
| `analyze` | 发件地址统计、标签枚举、去重建议 |
| `sieve` | Filter 模型 → Sieve 文本（含 gaps 标注） |
| `ui` | 预览与导出 |

---

## 5. 技术选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 构建 | **Vite + CRXJS + TypeScript** | MV3 一等支持；一次构建产出 Chrome / Firefox / Edge 三份 |
| 解包 | **fflate** | 同时支持 zip / gzip / tar，体积小、速度快、可在浏览器异步流处理 |
| mbox 解析 | **自写流式切分器** | MVP 只需切分 + 抽 3 个头，无需完整 MIME 库；可控、零依赖 |
| XML 解析 | 浏览器内置 **DOMParser** | 无需第三方库 |
| Sieve 生成 | 字符串模板 + **Blob 下载** | 纯文本拼接，下载用 Blob 免 `downloads` 权限 |
| 状态 | **IndexedDB**（可选） | 大包场景下暂存模型，避免 service worker 失活丢状态 |

为什么不用 CLI 方案里的 MimeKit / System.CommandLine：扩展运行在沙箱 JS 环境，无 `fs`、无 .NET 运行时，必须改 JS 技术栈，但**解析/映射/生成逻辑可 1:1 平移**。

---

## 6. 子功能可行性

| 子功能 | 输入 | 输出 | 难度 | 关键难点 | 降级方案 |
|---|---|---|---|---|---|
| 6.1 解析过滤规则 | `mailFilters.xml` | Filter 模型 | 低 | XML 命名空间 | 无 |
| 6.2 规则 → Sieve | Filter 模型 | `rules.sieve` + `gaps.md` | **中** | `hasTheWord` 搜索语法、Gmail 专属动作 | 不支持字段写 `gaps.md` 并注释跳过 |
| 6.3 标签 → 文件夹 | `Mail/*.mbox` 文件名 | `folders.json` | 低 | 多标签邮件重复 | 按 Message-ID 去重建议 |
| 6.4 发件地址分析 | `Sent.mbox` 的 `From:` 头 | `senders.csv` | 低 | 无 | 无 |

### 6.2 Gmail 过滤器 → Sieve 映射表（核心）

**条件（criteria）→ Sieve 测试**

| Gmail 字段 | 值示例 | Sieve 写法 | 备注 |
|---|---|---|---|
| `from` | `boss@x.com` | `address :is "from" "boss@x.com"` | `:contains` 亦可 |
| `to` | `me@x.com` | `address :contains "to" "me@x.com"` | |
| `subject` | `invoice` | `header :contains "subject" "invoice"` | |
| `hasTheWord` | `from:(a) subject:(b)` | 解析子句 → 组合 | **难点**：仅支持 from/to/subject/label/list/has:attachment/is:/larger:/smaller:/引文；复杂查询 → 注释跳过 |
| `doesNotHaveTheWord` | `...` | `not header / address ...` | |
| `hasAttachment=true` | — | `header :mime :contains "Content-Type" "multipart/mixed"` | 近似（Sieve 无原生「含附件」） |
| `size` + `sizeOperator` + `sizeUnit` | `s_sl`/`s_ss`，`s_sb`/`s_skb`/`s_smb` | `size :over / :under <字节>` | 需单位换算 |

**动作（actions）→ Sieve 动作**

| Gmail 字段 | Sieve 写法 | 备注 |
|---|---|---|
| `label=Work` | `fileinto "Work"` | 标签即文件夹 |
| `shouldArchive=true` | `fileinto "Archive"` | 近似（归档 = 移出收件箱） |
| `shouldMarkAsRead=true` | `addflag "\\Seen"` | 需 `imap4flags` |
| `shouldStar=true` | `addflag "\\Flagged"` | |
| `shouldTrash=true` | `fileinto "Trash"` | 不用 `discard`，避免永久删 |
| `forwardTo=addr` | `redirect "addr"` | |
| `shouldNeverSpam=true` | `keep`（注释说明） | **无精确等价** |
| `shouldAlways/neverMarkAsImportant` | 注释跳过 | **Sieve 无对应** |
| `smartLabelToApply=^smartlabel_*` | `fileinto "Social"` 等 | 分类近似值 |

> 所有「无精确等价」字段：生成时写入 `gaps.md` 并加 Sieve 注释，不让用户误以为已迁移。

### 6.3 标签 → 文件夹

- Takeout 已按标签拆成独立 mbox 文件 → 文件夹直接从文件名枚举。
- 嵌套标签名含 `/`（如 `Work/Projects`）→ 映射为 IMAP 文件夹层级。
- 多标签邮件会同时出现在多个 mbox → 上传/建文件夹时按 `Message-ID` 去重或接受重复（在 `folders.json` 注明）。

### 6.4 发件地址分析

- 扫描 `Sent.mbox`（或全量）的 `From:` 头，抽取地址并计数排序。
- 其中**非 @gmail.com** 的地址即「需要重配 Send mail as」的第三方地址——这正是 2027-01 改动直接冲击的部分，工具负责点出，不负责自动重配。

---

## 7. 上架方案（Chrome / Firefox / Edge 同步）

| 商店 | 费用 | 审核周期 | 必备材料 |
|---|---|---|---|
| Chrome Web Store | $5 一次性 | 数天 ~ 数周 | MV3 zip、128px 图标、截图、描述、**隐私政策 URL**、权限最小化声明 |
| Firefox Add-ons (AMO) | 免费 | 数天 ~ 1 周 | 同源清单，兼容即可 |
| Edge Add-ons | 免费 | 数天 | 可复用 Chrome 包 |

过审要点：

1. **隐私政策**必须写明「所有处理在本地完成，不上传任何邮件数据」——核心加分项，也是审查重点。
2. **权限最小化**：下载走 Blob 可免 `downloads` 权限；不申请 Gmail `host_permissions`；`manifest` 只列必要权限。
3. **CRXJS 三店构建**：一次配置产出三店包，边际成本低。

---

## 8. 开发计划（两周 + 收尾）

| 阶段 | 任务 | 交付 |
|---|---|---|
| W1-1 | Vite + CRXJS + TS MV3 脚手架；扩展 App 页 UI 骨架；上传组件（file / folder / 拖拽） | 能打开扩展页并选文件 |
| W1-2 | fflate 解包（zip / tgz）；mbox 流式切分器；DOMParser 读 `mailFilters.xml` → 模型 | 解析出规则 / 标签树 |
| W2-1 | 6.4 发件分析 + 6.3 标签 → `folders.json`；预览 UI（表格 / 排名渲染） | 预览页可见 |
| W2-2 | 6.2 规则 → Sieve 生成 + `gaps.md`；四文件下载 + 复制按钮 | 可用版 |
| 收尾 | 图标 / 截图 / 隐私政策 / 商店文案；打包提交 Chrome（FF / Edge 跟随） | 上架材料齐 |

时间线：构建 ~2 周末 + 商店审核 ~1–2 周，远在 2027-01 前。

---

## 9. 风险与已知缺口

| 风险 | 影响 | 缓解 |
|---|---|---|
| 大包内存（GB 级 Takeout） | 浏览器解析卡顿 / 崩溃 | fflate 异步流 + 支持文件夹直传跳过解包 + 超阈值提示 |
| MV3 service worker 不持久 | 处理中途状态丢失 | 状态按需算，必要时落 IndexedDB |
| `hasTheWord` 搜索语法复杂 | 部分规则无法精确转 | 标注进 `gaps.md`，非 bug |
| 多标签邮件重复 | 文件夹内容重复 | Message-ID 去重建议 |
| 目标差异（Outlook / Yahoo 无 Sieve） | 这两家只能人读配方 | 明确边界，出可读清单 |
| Send mail as 不在导出里 | 只能反推、不能自动重配 | 工具点出第三方发件地址，引导手工重配 |
| 商店拒审 | 上架延迟 | 隐私政策写清本地处理；权限最小 |
| Proton 免费版仅 1 条活跃 Sieve | 规则放不下 | 文档提醒升付费或合并规则 |

---

## 10. 后续可扩展（v1 之后）

- **IMAP 自动上传**：用 MailKit 思路的 JS IMAP 客户端（如 `imapflow`）直接把 mbox 推到 Fastmail / Proton（需 Bridge）；从「生成」升级为「一键落地」。
- **Outlook `.rwz` 生成**：覆盖消费者 Outlook 桌面规则文件。
- **Sieve 校验**：集成 `sievelib` 思路的 JS 校验器，生成前自检语法。
- **Gmail 设置页 content script**：在过滤器导出页加「一键送进本扩展」按钮（仍需用户手动下载，不碰 Gmail 数据）。

---

## 11. 待确认 / 开放问题

- 首发三店同步已确认；是否需要在 v1 就含 Firefox / Edge 的深链文案，还是先 Chrome 文案后补？（建议：CRXJS 一次出包，文案三店各写一份，边际成本低。）
- `rules.sieve` 是否默认仅生成 Fastmail / Proton 兼容子集，还是按目标服务商切换扩展集？（建议：v1 以 Fastmail 扩展集为准，兼容性最好。）
