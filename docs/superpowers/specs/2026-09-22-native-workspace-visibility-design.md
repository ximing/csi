# macOS Agent 工作区隐藏与页面收起按钮

状态：可行性实测完成，待用户评审。本文替代旧 workspace 设计中「正常窗口压到用户窗口后方」的显隐方案，尚未接入产品代码。

## 用户目标

- 平时看不到 Agent 窗口，不通过最小化送入 Dock。
- 点击 CSI 工具栏图标查看 Agent 会话列表，选择后看到该会话操作的网页。
- Agent 网页提供一个可以直接点击的「收起」按钮，再次从列表进入时恢复原网页。
- 按钮使用固定定位，不改变网页布局、viewport、截图坐标和页面滚动位置；允许覆盖按钮自身所占的小块区域。
- 「会话」指 Agent 操作的标签组，不是聊天记录。

## 2026-09-22 本机实测

环境：macOS 15.6，已运行的 Google Chrome，CSI daemon 0.7.4，扩展 0.9.0。仅操作专门创建的临时测试窗口，测试结束关闭这些窗口，未重启 daemon 或重载扩展。

Chrome 本机 scripting.sdef 明确暴露可写的 window.visible 属性。通过 osascript 调用 Chrome 自身 AppleScript 接口，不使用 System Events，不需要页面启用「Allow JavaScript from Apple Events」。

| 操作 | 结果 |
| --- | --- |
| 指定窗口 visible=false | visible=false、minimized=false，窗口和原 tab 仍存在 |
| 检查其他已有窗口 | visible、minimized 均未变化 |
| 隐藏后 CSI evaluate | 原页面变量保留，timer 仍推进，但受后台节流 |
| 隐藏后 CSI click | 按钮文本成功变成 clicked |
| 隐藏后 CSI screenshot | 生成并目视检查了有效截图，包含 clicked 按钮 |
| 隐藏后 Page.navigate | 页面导航成功，窗口仍不可见 |
| visible=true 恢复 | 原 tab 保留，minimized 仍为 false |
| AppleScript 添加 tab | 会唤出窗口，不采用此路径创建 Agent tab |
| 扩展 chrome.tabs.create({windowId, active:false}) | 新 tab 成功加入指定隐藏窗口，visible 仍为 false |

窗口 ID 与扩展 windowId 在本机实测一致；Chromium 的 WindowAppleScript 使用 BrowserWindowInterface.GetSessionID 生成 uniqueID。

事实边界：上表证明隐藏后普通 CDP 操作与后台新建标签可行，不证明与 ego 的合成、调度、Space 或 BrowserContext 机制等同。

## 选定方案

使用 Chrome 公开的 macOS 自动化接口设置单个窗口 visible，由 daemon 调用，扩展继续管理标签和 UI。

纯扩展 Windows API 没有 hidden 状态；最小化与压到后面都不满足用户要求。修改 Chromium 的 TabStripModel 能实现更完整的 Space，但超出本仓库的扩展与 daemon 修复范围。此次不采用私有 WindowServer API、移出屏幕或隐藏整个 Chrome 应用。

### 本地窗口桥接

先在 docs/protocol.md 定义工作区显隐接口，再修改实现。建议增加 POST /workspace/visibility，输入仅包含 windowId、workspaceUrl、visible；不新增 AI 工具，也不更改 session 所有权字段。

- daemon 验证 windowId 为正整数、visible 为必填布尔值、workspaceUrl 为 chrome-extension://<id>/workspace.html。
- macOS 实现只寻址 Google Chrome 对应 window ID，并验证它确实包含 workspaceUrl 占位标签，防止 stale ID 命中用户窗口。
- 使用固定 JXA 脚本和进程参数传值，通过 exec.CommandContext 调用 /usr/bin/osascript；不拼接 shell，不接受任意脚本输入。
- 调用受超时限制，完成后回读 visible 与 minimized。只有期望状态成立才返回成功。
- 保持现有监听地址和鉴权行为，不修改系统设置，不隐藏整个应用。
- 非 macOS、Apple Events 权限未授予、旧 daemon 没有接口、窗口已关闭或占位页不匹配时返回可识别错误，不静默降级成最小化或压到后面。
- 扩展从已配置的 daemon URL 派生 HTTP 地址，沿用已有凭据配置，不硬编码运行端口。

### 显隐状态与恢复

- workspace 窗口 ID 和用户主动展开状态存入 chrome.storage.session，后台 worker 唤醒不会误收起正在被用户查看的窗口。
- 新建窗口 focused:false，随后调用原生隐藏接口。隐藏成功后才继续创建 Agent 页面。
- 后台新建标签维持 active:false；移除 parkBehind 中反复聚焦用户窗口的操作。
- 用户从列表进入：校验目标标签仍属于该工作区，原生 visible=true，再激活所选标签与窗口。用户拖出工作区的标签只聚焦现有窗口，不把那个窗口当工作区隐藏。
- 点击收起：验证消息发送者仍位于持有占位页的工作区窗口；原生 visible=false 成功后记为隐藏；原用户窗口仍存在时返回它。原用户窗口已关闭也不能阻止收起。
- 创建、展开、收起通过同一工作区队列串行，避免异步隐藏覆盖刚发生的用户展开操作。
- 错误保留当前可恢复状态，页面按钮恢复可点击并显示简短错误；列表保留工作区入口。

### 页面按钮

- 仅在用户主动展开的工作区内、可注入的普通网页显示。
- 以扩展 isolated world/content script 实现，Shadow DOM 隔离样式；固定在右上角，不修改 document/body 的尺寸、margin 或滚动样式。
- 文案「收起」，支持键盘聚焦，点击只发工作区隐藏请求；后台根据 sender.tab/windowId 校验，页面不能指定任意窗口。
- 刷新、导航、切换标签后保持可用；标签被拖出工作区后移除。
- chrome://、Chrome Web Store 等不允许注入的页面使用工具栏图标直接收起作为替代；可为工作区标签禁用 action popup，并用 action.onClicked 触发同一个收起逻辑。
- 用户普通窗口仍点击 action popup 浏览会话列表。

## 必须告知的限制

1. 本方案针对 macOS Google Chrome，其他浏览器和系统尚未验证。
2. 首次由扩展创建窗口后才调用原生隐藏，不保证创建过程中完全没有短暂闪现。Chromium 的 AppleScript 创建窗口实现也先 Show，因此换成 AppleScript 创建不能据此承诺零闪现。若零闪现是硬条件，需要继续研究浏览器创建路径，不能把当前验证当作已达成。
3. 不最小化，不产生最小化窗口状态；尚未逐项验证 Mission Control、Chrome 的 Window 菜单、全屏 Space 和多显示器的所有表现。
4. 隐藏页面会被 Chrome 视为后台页面，动画与定时器可能节流；不通过 Page.bringToFront 解除节流。
5. 不保证网页主动 window.open、权限弹窗或裸 CDP bringToFront 永不唤出窗口，需要另测并明确支持范围。
6. macOS 可能要求运行 daemon 的宿主获得控制 Chrome 的自动化权限；本机 osascript 已可调用不代表所有安装环境均已授权。

## 验证与交付

- Go：输入校验、参数注入防护、错误和超时、非 macOS 返回、占位页身份检查。
- 扩展：隐藏/展开/新建竞态、worker 重启状态、原用户窗口关闭、拖出标签、native 接口失败和旧 daemon。
- 页面按钮：单例、固定定位不改变 viewport、刷新恢复、点击事件、错误可重试与非工作区不显示。
- 真实 Chrome：默认隐藏、后台新增标签、工具栏进入、页面按钮收起、再次进入、截图/点击/导航；同时检查 Dock、焦点与其他用户窗口。
- 执行 Go 测试、扩展测试、typecheck、build；安装后端到端验收前不宣称用户已可使用。

## 参考

- Chrome 本机：/Applications/Google Chrome.app/Contents/Resources/scripting.sdef
- Chromium AppleScript 设计：https://www.chromium.org/developers/design-documents/applescript/
- Chromium 窗口实现：https://github.com/chromium/chromium/blob/main/chrome/browser/ui/cocoa/applescript/window_applescript.mm
- Chrome 扩展窗口 API：https://developer.chrome.com/docs/extensions/reference/api/windows
- Chrome action API：https://developer.chrome.com/docs/extensions/reference/api/action
