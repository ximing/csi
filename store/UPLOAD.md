# Chrome Web Store 上架清单

CSI 扩展的上架步骤。打包产物为 `release/csi-extension-v<version>.zip`(manifest.json 在 zip 根)。

> 注:Chrome 平台禁止扩展脚本操作 Web Store 域名(`chrome.debugger` 对该域返回 "The extensions gallery cannot be scripted"),所以这一步只能手动,所有材料已备好为复制粘贴/拖拽。

## 0. 打包

```bash
scripts/package-extension.sh
```

产出 `release/csi-extension-v0.3.0.zip`。自检:`unzip -l` 确认 zip 根有 `manifest.json`,`icons/` `_locales/` `background.js` `popup.html` `options.html` 齐全。

## 1. 开发者账号(一次性)

- [x] 注册开发者账号,缴一次性注册费 **$5**。
- [ ] 开启 Google 账号两步验证(上架强制要求)。

## 2. 上传 zip

- [ ] Dashboard → **New Item** → 上传 `release/csi-extension-v0.3.0.zip`。
- [ ] 上传后确认 dashboard 无警告(权限说明、图标缺失等)。

## 3. Store listing(商品详情)tab

| Dashboard 字段 | 填什么 |
| --- | --- |
| 名称 | `store/listing.md` §1,EN 首选:`CSI — AI control for your real Chrome` |
| 简短说明 | `store/listing.md` §2(EN 128 字符,≤132 达标) |
| 详细说明 | `store/listing.md` §3,纯文本成稿直接粘贴 |
| 类别 | **Developer Tools**(理由见 `store/listing.md` §4) |
| 语言 | English(默认)+ 简体中文;中文短描述/详细描述用 `store/listing.md` 的 zh-CN 版 |
| 商店图标 128×128 | `extension/icons/128.png` |
| 截图 1280×800(1–5 张) | `store/assets/screenshot-1.png` ~ `screenshot-3.png`,caption 建议见 `store/listing.md` §7 |
| 小宣传图 440×280(可选) | `store/assets/promo-small.png` |
| 大宣传图 1400×560(可选) | `store/assets/promo-marquee.png` |
| 官网 / 支持链接 | `https://github.com/ximing/csi` |

## 4. Privacy practices(隐私做法)tab

英文成稿全部在 `store/review-notes.md`,逐字段对应粘贴:

- **Single purpose** — `review-notes.md` 的 single purpose 段
- **每个权限的 justification** — `debugger` / `tabs` / `activeTab` / `storage` / `alarms` / `tabGroups` / `windows` / `host_permissions <all_urls>`,共 8 条,`review-notes.md` 逐条有英文成稿
- **数据使用披露** — 全部选"不收集/不出本机",依据与措辞见 `review-notes.md`
- **远程代码声明** — 无远程代码(已核实)
- **隐私政策 URL** — `https://ximing.github.io/csi/privacy.html`(已上线,返回 200;源文件 `docs/privacy-policy.md` + `site/public/privacy.html`)
- **给审核员的备注** — `review-notes.md` 末尾:说明扩展需配合本机 daemon、如何测试

## 5. 发布前检查项

- [ ] `extension/manifest.json` 的 `version` 已递增(打包脚本按它命名 zip,商店要求每次上传版本号更大)。
- [ ] 本地 `chrome://extensions` 载入 `extension/dist/` 手工冒烟:popup 显示 connected,基本工具(navigate / screenshot)可用。
- [ ] listing 文案、截图与当前 UI 一致。
- [ ] 权限用途说明与 manifest 一致(改 manifest 权限要回来更新 `store/review-notes.md`)。
- [ ] 提交审核,等待结果(通常数天;被拒按反馈改后递增版本号重传 zip)。
