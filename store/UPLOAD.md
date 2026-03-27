# Chrome Web Store 上架清单

CSI 扩展的上架步骤。打包产物为 `release/csi-extension-v<version>.zip`（manifest.json 在 zip 根）。

## 0. 打包

```bash
scripts/package-extension.sh
```

脚本会：`cd extension && npm run build` → 从 `dist/manifest.json` 读版本号 → 打成
`release/csi-extension-v<version>.zip`（自动清理同名旧包、排除 `.DS_Store`，幂等可重复跑）。

自检：

```bash
unzip -l release/csi-extension-v*.zip   # zip 根必须有 manifest.json，且 icons/ _locales/ background.js popup.html options.html 齐全
```

## 1. 开发者账号（一次性）

- [ ] 在 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) 注册开发者账号，缴一次性注册费 **$5**。
- [ ] 开启 Google 账号两步验证（上架强制要求）。

## 2. 上传 zip

- [ ] Dashboard → New Item → 上传 `release/csi-extension-v<version>.zip`。
- [ ] 上传后确认 dashboard 无警告（权限说明、图标缺失等）。

## 3. Listing / 审核材料

| Dashboard 字段 | 对应本仓库文件 |
| --- | --- |
| 名称 / 简短说明 / 详细说明 | `store/listing.md`（待补） |
| 商店图标 128×128 | `extension/icons/128.png` |
| 截图 1280×800（1–5 张） | `store/screenshots/`（待补） |
| 小宣传图 440×280（可选） | `store/promo/`（待补） |
| 类别 | Productivity / Developer Tools |
| 语言 | English + 简体中文（与 `_locales/` 对齐） |
| 隐私政策 URL | **待填**（占位：`store/privacy-policy.md` 定稿后托管到可公开访问的 URL，如 GitHub Pages 站点页） |
| 官网 / 支持链接 | GitHub 仓库 URL |

## 4. 权限用途说明（审核必填）

按 `manifest.json` 现有权限如实填写：

- `debugger` — 通过 CDP 在用户已打开的页面上执行点击/输入/截图等操作（核心功能）。
- `tabs` / `windows` / `tabGroups` — 枚举与管理标签页、按会话分组。
- `activeTab` — 操作当前活动标签页。
- `storage` — 保存端口等本地配置。
- `alarms` — 断线重连定时。
- `host_permissions: <all_urls>` — 用户可能让 AI 操作任意网站，需在任意页面上 attach debugger。
- **远程代码**：无（所有 JS 均在包内）。
- **数据使用**：不收集、不传输任何用户数据；所有流量仅本机 loopback（daemon 绑 `127.0.0.1:10088`）。如实勾选数据合规声明。

## 5. 发布前检查项

- [ ] `extension/manifest.json` 的 `version` 已递增（打包脚本按它命名 zip，商店要求每次上传版本号更大）。
- [ ] 本地 `chrome://extensions` 载入 `extension/dist/` 手工冒烟：popup 显示 connected，基本工具（navigate / screenshot）可用。
- [ ] 隐私政策 URL 已填且公开可访问。
- [ ] listing 文案、截图与当前 UI 一致。
- [ ] 权限用途说明与 manifest 一致（改 manifest 权限要回来更新本文档 §4）。
- [ ] 提交审核，等待结果（通常数天；被拒按反馈改后重传新版本号 zip）。
