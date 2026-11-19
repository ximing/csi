# 后台操作浏览器而不打断用户

记录日期：2026-11-19。这是调研结论，不是已实现的协议变更。

## 结论

部分能做到。

不切走用户正在看的标签、不拿走键盘焦点，现有 Chrome API 做得到。被挡住、最小化，或放在另一个 macOS Space 时，还要让动画、视频和视口截图与前台标签一样，做不到。补上 `Page.bringToFront` 能恢复绘制，那一步就是把标签拉到前面。

## 能做到的

- 新建或更新标签时传 `active: false`。Chrome 文档写明：这只决定该窗口里哪一个标签被选中，不改变窗口有没有焦点。`tabs.create` 的 `active` 默认是 `true`，省略就会选中新标签。见 [tabs.create](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-create)、[tabs.update](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-update)。
- `windows.create({ focused: false })` 的文档是「打开一个非活动窗口」。见 [windows.create](https://developer.chrome.com/docs/extensions/reference/api/windows#method-create)。`windows.update` 的 `focused: true` 才会把窗口拿到最前。见 [windows.update](https://developer.chrome.com/docs/extensions/reference/api/windows#method-update)。
- 读 DOM、在页面里 `element.click()`、执行脚本，不需要把窗口变成键窗口。ego-lite 在截图挂起时，这些调用仍然成功。见 [citrolabs/ego-lite#293](https://github.com/citrolabs/ego-lite/issues/293)。
- macOS 上对后台标签发可信鼠标事件，有人测到可以不抬窗口。Cua 在 Chrome 155 上的测量写在 `standalone_trusted_input_background_limitation()`：返回 `None`，并注明不调用 `Page.bringToFront` 或 `Target.activateTarget`。见 [platform.rs](https://github.com/trycua/cua/blob/052dc3a0c19646f89d5e6ca30e110e2dd541eec2/libs/cua-driver/rust/crates/platform-macos/src/browser/platform.rs)。现行说明：[Cua browser tools](https://cua.ai/docs/concepts/browser-targeting-and-background-delivery)。这是他们的测量，不是 Chrome 的保证。

CSI 今天已经按 `active: false` 建标签；独立窗口是弹窗开关，默认关。见 [agent-window.ts](https://github.com/ximing/csi/blob/master/extension/src/background/agent-window.ts)。

## 做不到或不保证的

- **开新窗口、在后台窗口里开新标签，macOS 上仍可能把整个 Chrome 激活。** [398173033](https://issues.chromium.org/issues/398173033) 记录 `windows.create({ focused: false })` 曾把上一个 Chrome 窗口激活；修复是 [6320633](https://chromium-review.googlesource.com/c/chromium/src/+/6320633)，只在 Chrome 已经是前台应用时才恢复上一个窗口。[579458639](https://issues.chromium.org/issues/579458639)（2026-10-29）记录：Chrome 在后台时，后台窗口里开新标签仍可能调用 `[NSApp activateIgnoringOtherApps:YES]`。
- **不传焦点参数的 `Target.createTarget` 会把窗口带到前台。** 协议写明：`background` 默认 false；此时省略 `focus`，新目标被聚焦，浏览器窗口到前台。`background: false` 且 `focus: false` 时，窗口焦点保持原样。`Page.bringToFront` 的定义是 “Brings page to front (activates tab)”。`Target.activateTarget` 的定义是 “Activates (focuses) the target”。见 [Target.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Target.pdl)、[Page.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl)。`focus` 参数来自 [475918785](https://issues.chromium.org/issues/475918785)，提交 [7500236](https://chromium-review.googlesource.com/c/chromium/src/+/7500236)。
- **焦点仿真不等于前台绘制。** `Emulation.setFocusEmulationEnabled` 的协议原文是 “simulating a focused and active page”（[Emulation.pdl](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl)）。[browser-use/jev-ultrafast#51](https://github.com/browser-use/jev-ultrafast/issues/51) 在 Windows 上测到：后台标签开了焦点仿真后 `document.visibilityState` 仍是 `visible`，弹层来不及画出来；加一次 `Page.bringToFront` 后同一任务才通过。另一个客户端还能把这次仿真关掉：[570354843](https://issues.chromium.org/issues/570354843)。
- **被挡住的窗口上，视口截图会挂住。** ego-lite 在窗口被挡住、最小化或在另一个 Space 时，`Page.captureScreenshot` 超时，`fromSurface: false` 同样超时；`Page.printToPDF` 成功。CSI 的截图没有传 `fromSurface`，协议默认是 true。见 [screenshot.ts](https://github.com/ximing/csi/blob/master/extension/src/background/tools/screenshot.ts)。
- **Linux 上可信 CDP 鼠标会激活窗口。** Cua 因此直接拒绝，见 [browser_platform.rs](https://github.com/trycua/cua/blob/052dc3a0c19646f89d5e6ca30e110e2dd541eec2/libs/cua-driver/rust/crates/platform-linux/src/browser_platform.rs) 与 [tools.rs](https://github.com/trycua/cua/blob/052dc3a0c19646f89d5e6ca30e110e2dd541eec2/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs)。
- **agent-browser 的后台模式没有合并。** 问题描述在 [vercel-labs/agent-browser#1247](https://github.com/vercel-labs/agent-browser/issues/1247)。[PR #1427](https://github.com/vercel-labs/agent-browser/pull/1427) 和 [PR #1695](https://github.com/vercel-labs/agent-browser/pull/1695) 在记录时仍是 open。不能把 issue 评论里的本地中继当成上游实现。

## Agent 约束

普通浏览和现场验证都不要发 `Page.bringToFront` 或 `Target.activateTarget`，包括经由 `cdp`。`find_tab(active:true)` 只在用户明确要操作他正在看的那一页时使用。定时器或动画不跑，是后台节流：把 `wait` 拉长，然后告诉用户。不要用把 Chrome 拉到前面来“修好”它。

e2e 回放模板里的 `openPage` 仍会调用一次 `Page.bringToFront`，那是无人值守回放为了定时器和绘制。不要在现场验证里再调一次，也不要在套件里追加调用。

更早的 Cua 0.17.0 曾在 macOS 上拒绝后台可信点击（[trycua/cua#2811](https://github.com/trycua/cua/issues/2811)，2026-08）。当前 `052dc3a` 的 macOS 实现与之相反，以当前源码为准。
