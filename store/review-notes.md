# CSI — Chrome Web Store 审核材料

提交 CWS 后台"隐私做法"（Privacy practices）页时直接复制下文对应的英文段落。

## Single purpose（单一用途声明）

> CSI lets a locally installed AI agent daemon control the user's own Chrome browser — open pages, click, fill forms, read page content, take screenshots, and automate web tasks — using the user's real browser sessions. The extension is the browser-side executor for the CSI daemon, a companion program the user installs and runs on their own machine (127.0.0.1 only). Every action the extension takes is a tool call issued by that local daemon on the user's behalf.

中译（仅供自己参考，不必提交）：CSI 让本机安装的 AI agent daemon 控制用户自己的 Chrome 浏览器——打开页面、点击、填表、读取页面内容、截图、自动化网页任务——全程使用用户真实的浏览器会话。扩展是 CSI daemon 的浏览器侧执行器；daemon 是用户自行安装、只监听 127.0.0.1 的本地程序。扩展的一切动作都是 daemon 代表用户发起的工具调用。

## Permission justifications（权限用途说明）

### tabs

> The extension lists, creates, reuses, and closes browser tabs as part of executing automation commands from the local daemon. Concretely: `list_tabs` enumerates open tabs so the agent can pick a target; `navigate` creates a tab or reuses the current one and waits for page load via `chrome.tabs.onUpdated`; `find_tab` locates an existing tab by URL/title; `close_tab`/`close_session` close tabs the session opened. Tab tracking (`chrome.tabs.get` / `chrome.tabs.query`) is also used to resolve which tab a command should act on.

### activeTab

> When a command does not specify a target tab, the extension falls back to the tab the user is currently using (see `tab-manager.ts`, which queries the active tab of the current window and remembers it as the command target). activeTab ensures the extension can act on that user-focused tab — e.g. read its content or screenshot it — at the moment the user (via the local daemon) directs it to.

### debugger

> This is the core execution mechanism. The extension attaches `chrome.debugger` (CDP 1.3) to the target tab and sends Chrome DevTools Protocol commands to perform the actual automation: `Page.navigate`, `Runtime.evaluate` (read page content, element refs), `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` (click, type, send keys), `Page.captureScreenshot`, `Page.printToPDF`, `Network.enable` request capture, and file upload via `DOM.setFileInputFiles`. Attaching is idempotent and the extension cleans up when a tab closes or the user detaches the debugger manually (the yellow infobar's "Cancel"). No page data leaves the machine: CDP results are returned only to the local daemon over a loopback WebSocket.

### storage

> `chrome.storage.local` stores only the extension's own connection settings: whether it should connect to the local daemon (`ws_should_connect`), the daemon WebSocket URL (`local_url`, default `ws://127.0.0.1:10088/ws`), and the reconnect-alarm period. These values persist across service-worker suspension so the extension can resume its connection. No browsing data, page content, or personal information is stored.

### alarms

> A single periodic alarm (`csi-reconcile`) wakes the MV3 service worker to reconcile connection state: if the user's settings say the extension should be connected to the local daemon but the WebSocket dropped (e.g. after the worker was suspended), it reconnects. The period is user-configurable in the options page (minimum 30s per Chrome's alarm limit); it does nothing else.

### tabGroups

> Tabs that the daemon opens for an automation session are visually grouped and color-coded as `agent:<session>` tab groups, so the user can see at a glance which tabs belong to the agent versus their own browsing, and collapse or close them as a unit. Grouping is strictly best-effort and never blocks a command; before closing session tabs the extension ungroups them only when the entire group is session-owned, so user-owned tabs in mixed groups are never disturbed.

### windows

> `find_tab` uses `chrome.windows.getLastFocused` to scope tab searches to the window the user is actually working in, so automation targets a tab in the focused window rather than an identically-titled tab in another window. This is the only use of the windows API.

### host_permissions — `<all_urls>`

> The extension's purpose is to let the user's local AI agent operate any website the user is logged into — that is the product. The set of sites is not known in advance: the user may ask the agent to read or act on any page they can open themselves. Host access is exercised exclusively through the `chrome.debugger` CDP session on the specific tab a command targets, at the moment the local daemon issues that command; there is no background crawling, no content script injected into pages, and no data sent anywhere except the loopback daemon. Broad host permission is required because a per-site opt-in list would defeat the single purpose of the extension.

## 数据使用披露（Data usage）

CWS 认证问答建议答案：

- **Does your extension collect or transmit user data?** → **No.**
- 详细说明（若要求补充）：

> The extension does not collect, transmit, sell, or share any user data with any third party, and does not transmit any data off the user's machine. Its only network connection is a WebSocket (and, from the options page, plain HTTP status checks) to a companion daemon running on the same computer at 127.0.0.1 (default port 10088), installed and controlled by the user. Page content, screenshots, and automation results travel exclusively over that loopback connection to the local daemon; nothing is sent to any remote server. The extension stores no personal data — only its own connection settings in chrome.storage.local.

- 对应勾选项：所有 data type（personal communications / health / financial / authentication / browsing history 等）均声明 **not collected**。注意：虽然扩展技术上能读取页面内容，但按 CWS 定义"collect"指传输给开发者或第三方——这里数据不出本机、开发者无任何服务端，因此如实填"不收集"。
- Privacy policy URL：因不收集数据，CWS 不强制要求隐私政策链接；如后台坚持要填，可放 GitHub 仓库 README 链接。

## Remote code 声明

> This extension does not load or execute any remote code. All JavaScript is bundled at build time (Vite) into the extension package; there are no remote script tags, no dynamic `import()` of remote modules, no `eval`/`new Function`, and no code fetched at runtime. The only runtime network traffic is the loopback WebSocket to the local daemon (`ws://127.0.0.1:10088/ws` by default), which carries JSON tool-call messages — never executable code. Verified by inspecting `src/`: the only `fetch`/URL references resolve to `127.0.0.1`.

后台对应勾选：**No, my extension does not use remote hosted code.**

## 给审核员的备注（Notes for reviewers）

> CSI is one half of a two-part local system: this extension plus an open-source daemon (Go binary, https://github.com/ximing/csi) that the user installs on their own machine. The daemon listens only on 127.0.0.1:10088 and relays tool calls from a local AI client to the extension over a loopback WebSocket. Without the daemon, the extension still loads cleanly — its popup simply shows "Disconnected".
>
> To review:
> 1. Load the extension unpacked (or install from the submitted package). The popup shows connection status and the daemon address.
> 2. For full end-to-end behavior, build/run the daemon from the public repo (`go build ./cmd/csi`, then run `csi`); the extension connects automatically and the daemon's `POST /command` endpoint drives tools like navigate, snapshot, click, and screenshot. An `npm run build` of the extension source reproduces the submitted `dist/`.
> 3. You can also exercise the extension without the daemon: open the options page to view/edit settings (stored in chrome.storage.local) and observe the reconnect alarm behavior.
>
> The debugger infobar ("CSI is debugging this browser") shown while a command runs is Chrome's standard debugger banner; it appears only while the debugger is attached and disappears on detach.

## 材料覆盖核对

- [x] single purpose
- [x] 权限 justification × 8（tabs / activeTab / debugger / storage / alarms / tabGroups / windows / `<all_urls>`）
- [x] 数据使用披露（不收集、不出本机）
- [x] remote code 声明（已核实 src 无远程加载）
- [x] 审核员测试方式备注
