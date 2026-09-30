# 手工发布检查单

0.1.0 是 beta；发布 ZIP 与浏览器商店上架是不同步骤。维护者须自行补齐真实仓库地址、隐私政策公开地址及安全/行为准则联系渠道。

## 1. 验证

- [ ] 使用干净工作区，核对 `package.json`、manifest 和 CHANGELOG 版本一致。
- [ ] Node.js 20+，执行 `npm ci`；首次需要浏览器时运行 `npx playwright install chromium`。
- [ ] 执行 `npm run check`（Node 测试 → 构建 → Chromium 浏览器测试 → 包校验）。记录通过、跳过、未验证事项，不将历史结果当作本次结果。
- [ ] Node 基线为 157 个测试中 156 通过、1 个浏览器原生 DOMParser 测试在 Node 跳过；相关解析在 Playwright 中覆盖。如测试变化，更新实际数量。
- [ ] 检查真实账户资料不在包中，权限为空且无 host_permissions、远程资源、遥测或账号代码。
- [ ] 确认近似规则仍注释禁用，缺口明确，取消/重置和异常文件可恢复。
- [ ] 实际加载 Chrome/Edge 包，测试打开扩展和本地导入导出。Firefox 必须单独测试并记录；开发期间未启动 Firefox，现有构建检查不能代替它。
- [ ] Fastmail/Proton 真实账号未验证，不在发行说明中称“已兼容”。

## 2. 核对包

`npm run build` 应生成：

- `dist/chrome/`（Chrome / Edge）
- `dist/firefox/`
- `dist/GmailChanger-chrome.zip`
- `dist/GmailChanger-firefox.zip`

执行 `node scripts/verify-packages.mjs`，并手工检查 ZIP 根目录有 manifest、index、background 与 assets，而不是再嵌套一层 dist。Firefox 使用自己的 background 配置。不要把真实邮箱样本打进包。

## 3. 标签和 GitHub Release

1. 更新 CHANGELOG，提交经过复核的改动。
2. 确认本地版本后创建并推送标签（示例，不能重复使用已发布标签）：

   ```sh
   git tag -a v0.1.1 -m "GmailChanger 0.1.1 beta"
   git push origin v0.1.1
   ```

3. `.github/workflows/release.yml` 在 `v*` 标签推送时执行 Node 测试、构建、包校验，并通过 `softprops/action-gh-release` 附上两个 ZIP。它在 Windows Runner 上运行完整 `npm run check`（含 Playwright）；发布前本地仍应复核一次。
4. 核对 GitHub Release 附件、标签提交和说明。必要时手工创建 Release 并上传上述两个 ZIP；beta 应标记为 prerelease。
5. 下载发布附件再安装检查，不只验证工作目录中的构建。

## 4. 可选商店发布

- Firefox AMO：提交 Firefox 包及要求的源码/说明，完成签名。普通发行版 Firefox 的长期安装通常要求签名；`about:debugging` 临时加载不等于正式安装。
- Edge Add-ons（Microsoft Edge 加载项）：
  1. 用 Microsoft 账号注册 [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge) 开发者计划（个人账号免费，公司账号需验证）。
  2. 「Create new extension」上传 `dist/GmailChanger-chrome.zip`——Edge 直接接受 Chrome/MV3 构建，无需改动。
  3. 商店资料：名称与描述可沿用 manifest；类别选生产力工具；隐私政策 URL 填仓库中 `PRIVACY.md` 的公开地址；支持网站填仓库地址。
  4. 权限说明如实填写：扩展权限为空、无 host_permissions、无网络请求、无遥测，所有数据本地处理。
  5. 提交审核，通过后商店分发。此后每个新版本先递增 manifest 版本号，再上传新 ZIP。
- Chrome Web Store：维护者需要开发者账号，并承担**一次性开发者注册费**（金额以注册页面为准）；不是向用户收费，也不是捐赠门槛。

准备准确截图、MIT 许可、隐私政策与权限说明。商店审核、费用和套餐可能变化，不承诺审核时间或上线状态。发布不改变“100% 免费、无付费功能、无捐赠或支付集成”的原则。
