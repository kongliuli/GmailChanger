# 参与贡献

欢迎小而可验证的修复。GmailChanger 是 100% 免费、MIT 开源的本地配置助手，不是邮件搬运工具。

## 开始

Node.js 20+；先 fork 仓库，再克隆你自己的 fork（把 `<你的 GitHub 用户名>` 替换为真实账号，仓库地址由维护者补齐，不使用猜测的 URL）。

```sh
npm install
npm run dev
npm test
npm run build
npx playwright install chromium
npm run test:browser
npm run check
```

CI 使用锁文件与 `npm ci`。`npm run dev` 是开发网页，不等同于装载扩展；浏览器安装请见 [README](README.md)。检查 [架构](docs/architecture.md) 和 [规则映射](docs/supported-rules.md) 后再修改转换逻辑。

## 不可协商的安全规则

- **绝不静默扩大规则匹配范围。** 不支持的有效条件或动作必须跳过整条规则，不能只删掉它们。近似规则默认注释禁用。
- 不添加邮件传输、自动登录、网络请求、遥测、远程资源或主机权限。开发服务器/测试工具的本地连接不属于扩展运行时能力。
- 不生成永久删除动作；不要把来信 From 当作用户发件身份。
- 保留 XML、ZIP、MBOX 输入边界及取消/错误处理；更改限制必须说明风险并加回归测试。
- 新依赖必须解释为什么现有依赖、标准库或浏览器 API 不够，以及包体积、安全和许可证影响。
- 不提交真实地址、邮件正文、未脱敏过滤器、cookies、tokens 或支付账号秘密。测试数据使用合成样本，见 [test-data](docs/test-data.md)。
- 测试必须保持通过。修复解析/安全分支要有最小回归测试；不能为了绿色 CI 删除安全断言。
- 不引入付费层、功能门槛或捐赠/支付集成。

## 提交与 PR

提交用 `fix: ...`、`feat: ...`、`docs: ...`、`test: ...`、`chore: ...` 等简洁前缀，正文解释原因而非复述 diff；一次 PR 聚焦一个问题，不顺手格式化无关文件。

提交前检查：

- [ ] 说明问题、方案、风险和验证命令；所有示例已脱敏。
- [ ] `npm run check` 通过；若环境缺少浏览器，明确写出未运行项及原因，不能声称通过。
- [ ] XML/ZIP/MBOX 失败路径及近似规则默认禁用未退化。
- [ ] 未增加网络/权限、未经解释的依赖或付费门槛。
- [ ] 修改涉及文档、规则矩阵和 CHANGELOG 时同步更新。
- [ ] 不将 Chromium 网页测试称为 Firefox 或真实邮箱兼容性测试。

遵守 [行为准则](CODE_OF_CONDUCT.md)。安全问题不要附带个人数据公开报告；维护者须在 SECURITY.md 补齐私密联系渠道。
