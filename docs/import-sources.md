# 各邮箱服务的本地导出来源

本工具不登录任何邮箱、不做 IMAP 拉取。所有输入都来自你在本机已有的导出文件。支持 XML（Gmail 过滤器）、MBOX（每文件夹一个文件）、EML（每封邮件一个文件）、受限 ZIP 或已解压文件夹。

| 来源 | 官方导出方式 | 得到的形态 | 备注 |
|---|---|---|---|
| Gmail | Google Takeout → Gmail | ZIP 内多个 `.mbox` + `mailFilters.xml` | 迁移模式与清点模式都可直接使用 |
| Apple Mail | 邮箱右键 → 导出邮箱 | `.mbox` | 直接选择导出文件 |
| Thunderbird | 本地即 mbox 存储；ImportExportTools NG 可批量导出 | `.mbox` 或逐封 `.eml` | 两种都支持 |
| Fastmail | 设置 → Download all your data | ZIP（含 mbox）；单封邮件可另存 raw `.eml` | 两种都支持 |
| Proton Mail | 官方 Export Tool（命令行） | **逐封 `.eml`** + JSON 元数据 | 无需 Bridge；直接选 EML 文件或其所在文件夹/ZIP |
| Outlook.com | 无浏览器直导 | — | 需经桌面客户端（如 Thunderbird IMAP）导出为 mbox/eml 后再导入；本工具不解析 PST |

清点模式对“来自哪个邮箱”没有要求：多个地址的导出可以分批导入，账号证据按发件域聚合，同一封邮件跨文件按 Message-ID 去重。

## 网页版

`npm run build` 产出的 `dist` 根目录（`index.html` + `assets`）就是普通静态网页，与扩展版共用同一构建产物与全部能力；扩展版仅多了 `manifest.json` 与后台脚本。没有服务端：直接用浏览器打开本地文件或自行静态托管即可，处理仍然全部在本机浏览器内完成。

## 输入边界

- ZIP：512 MiB 输入、128 MiB 单项、256 MiB 接受条目总展开量、2000 接受条目；不安全或不支持的归档（含 ZIP64、加密）整体拒绝。
- XML：10 MiB 上限。
- Message-ID 去重：发件候选与账号证据各自维护集合，每集合上限 100000；缺失 ID 与超限会影响计数，界面与导出中均有提示。
