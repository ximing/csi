# CSI — Chrome Web Store 审核材料

提交 CWS 后台"隐私做法"（Privacy practices）页时直接复制下文对应的英文段落。

## Single purpose（单一用途声明）

> CSI lets a locally installed AI agent daemon control the user's own Chrome browser — open pages, click, fill forms, read page content, take screenshots, and automate web tasks — using the user's real browser sessions. The extension is the browser-side executor for the CSI daemon, a companion program the user installs and runs on their own machine (127.0.0.1 by default). Every action the extension takes is a tool call issued by that local daemon on the user's behalf.

中译（仅供自己参考，不必提交）：CSI 让本机安装的 AI agent daemon 控制用户自己的 Chrome 浏览器——打开页面、点击、填表、读取页面内容、截图、自动化网页任务——全程使用用户真实的浏览器会话。扩展是 CSI daemon 的浏览器侧执行器；daemon 是用户自行安装、默认监听 127.0.0.1 的本地程序。扩展的一切动作都是 daemon 代表用户发起的工具调用。

## Permission justifications（权限用途说明）

### tabs

> The extension lists, creates, reuses, and closes browser tabs as part of executing automation commands from the local daemon. Concretely: `list_tabs` enumerates the tabs owned by the session; `navigate` creates a new tab or reuses the session's current *owned* tab and waits for page load via `chrome.tabs.onUpdated`; `find_tab` locates a session-owned tab by URL domain, or with `active:true` scopes the search to the user's foreground tab in the last-focused window; `close_tab`/`close_session` close only tabs the session opened. The target tab for every command is supplied by the daemon (`_tabId`); the extension uses `chrome.tabs.get` only to verify that target still exists, and never silently falls back to an unrelated active tab.

### debugger

> This is the core execution mechanism. The extension attaches `chrome.debugger` (CDP 1.3) to the target tab and sends Chrome DevTools Protocol commands to perform the actual automation: `Page.navigate`, `Runtime.evaluate` (read page content, element refs), `Input.dispatchMouseEvent`/`Input.dispatchKeyEvent` (click, type, send keys), `Page.captureScreenshot`, `Page.printToPDF`, `Network.enable` request capture, and file upload via `DOM.setFileInputFiles`. Attaching is idempotent and the extension cleans up when a tab closes or the user detaches the debugger manually (the yellow infobar's "Cancel"). No page data leaves the machine: CDP results are returned only to the local daemon over a loopback WebSocket.

### storage

> `chrome.storage.local` stores the extension's connection and window settings: whether it should connect to the local daemon (`ws_should_connect`), the daemon WebSocket URL (`local_url`, default `ws://127.0.0.1:10088/ws`), the reconnect-alarm period, and the Agent window preference. These values persist across service-worker suspension so the extension can resume its connection. No browsing data, page content, or personal information is stored.

### alarms

> A single periodic alarm (`csi-reconcile`) wakes the MV3 service worker to reconcile connection state: if the user's settings say the extension should be connected to the local daemon but the WebSocket dropped (e.g. after the worker was suspended), it reconnects. The period is user-configurable in the options page (minimum 30s per Chrome's alarm limit); it does nothing else.

### tabGroups

> Tabs that the daemon opens for an automation session are visually grouped and color-coded as `agent:<session>` tab groups, so the user can see at a glance which tabs belong to the agent versus their own browsing, and collapse or close them as a unit. Grouping is strictly best-effort and never blocks a command; before closing session tabs the extension ungroups them only when the entire group is session-owned, so user-owned tabs in mixed groups are never disturbed.

### windows

> `find_tab` uses `chrome.windows.getLastFocused` to scope tab searches to the window the user is actually working in, so automation targets a tab in the focused window rather than an identically-titled tab in another window. This is the only use of the windows API.

### host_permissions — `<all_urls>`

> The extension's purpose is to let the user's local AI agent operate any website the user is logged into — that is the product. The set of sites is not known in advance: the user may ask the agent to read or act on any page they can open themselves. Host access is exercised exclusively through the `chrome.debugger` CDP session on the specific tab a command targets, at the moment the local daemon issues that command; there is no background crawling, no content script injected into pages, and no data sent anywhere except the configured daemon (loopback by default). Broad host permission is required because a per-site opt-in list would defeat the single purpose of the extension.

## 数据使用披露（Data usage）

CWS 认证问答建议答案：

- **Does your extension collect or transmit user data?** → **No.**
- 详细说明（若要求补充）：

> The extension sends browser tool results to the daemon address configured by the user, which defaults to ws://127.0.0.1:10088/ws. The options page also makes HTTP requests to the configured daemon. Page content and automation results are returned to the client that issued the command. A non-local daemon address or network-accessible daemon can therefore carry data beyond the browser's machine. Browser data is not sent to the project maintainers. Connection and window preferences are stored locally in the browser.

- 提交数据披露时使用上述实际数据流描述；不要再以“数据一定不出本机”为依据。
- Privacy policy URL：因不收集数据，CWS 不强制要求隐私政策链接；如后台坚持要填，可放 GitHub 仓库 README 链接。

## Remote code 声明

> Extension JavaScript is bundled at build time with Vite. Runtime connections use the daemon URL configured by the user (loopback by default), over WebSocket and HTTP. Tool calls include CDP and evaluate capabilities that can execute caller-supplied code inside the target page; this is separate from loading extension JavaScript.

后台对应勾选：**No, my extension does not use remote hosted code.**

## 给审核员的备注（Notes for reviewers）

> CSI is one half of a two-part local system: this extension plus an open-source daemon (Go binary, https://github.com/ximing/csi) that the user installs on their own machine. The daemon listens on 127.0.0.1:10088 by default and relays tool calls from a local AI client to the extension over a loopback WebSocket. Without the daemon, the extension still loads cleanly — its popup simply shows "Disconnected".
>
> To review:
> 1. Load the extension unpacked (or install from the submitted package). The popup shows connection status and the daemon address.
> 2. For full end-to-end behavior, build/run the daemon from the public repo (`go build ./cmd/csi`, then run `csi`); the extension connects automatically and the daemon's `POST /command` endpoint drives tools like navigate, snapshot, click, and screenshot. An `npm run build` of the extension source reproduces the submitted `dist/`.
> 3. You can also exercise the extension without the daemon: open the options page to view/edit settings (stored in chrome.storage.local) and observe the reconnect alarm behavior.
>
> The debugger infobar ("CSI is debugging this browser") shown while a command runs is Chrome's standard debugger banner; it appears only while the debugger is attached and disappears on detach.

## 材料覆盖核对

- [x] single purpose
- [x] 权限 justification × 7（tabs / debugger / storage / alarms / tabGroups / windows / `<all_urls>`）
- [x] 数据使用披露（按配置的 daemon 数据流说明）
- [x] remote code 声明（已核实 src 无远程加载）
- [x] 审核员测试方式备注
