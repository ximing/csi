# Chrome Web Store 上架文案 / Chrome Web Store Listing Copy

CSI 扩展的 CWS 上架素材。英中双语并列；详细描述为纯文本（CWS 不渲染 markdown），直接按换行粘贴。

---

## 1. 名称 / Name

CWS 名称上限 45 字符。

**EN（首选，38 字符）**

```
CSI — AI control for your real Chrome
```

**EN（备选，31 字符，保留品牌双关）**

```
CSI — Crime Scene Investigation
```

**zh-CN（19 字符）**

```
CSI — 让 AI 控制你的真实 Chrome
```

副标题思路（如需）：主名保持 "CSI"，副标题承载功能说明；品牌双关（Ctrl+Shift+I / Crime Scene Investigation）放在详细描述第一段解释，不占名字段。

---

## 2. 简短描述 / Short description

CWS 硬限制 ≤132 字符。下列字符数按 Unicode 字符计（与 CWS 口径一致）。

**EN（128 字符）**

```
Let AI control your real Chrome: navigate, click, type, read, screenshot, save PDFs — with your real login sessions. Local only.
```

**zh-CN（70 字符）**

```
让 AI 控制你真实的 Chrome：导航、点击、输入、读取页面、截图、保存 PDF——使用你实际的登录态。本地 daemon，仅回环监听。
```

说明：中文版把"仅回环监听"放进短描述，因为安全边界是本扩展的差异化卖点，且中文字符密度高、放得下；英文版 132 字符放不下等值表述，安全边界由详细描述第一段承担。

---

## 3. 详细描述 / Detailed description

纯文本 + 换行，不使用 markdown 语法（CWS 不渲染）。以下为可直接粘贴的成稿。

### EN

```
CSI lets an AI agent (Claude Code or any MCP-capable client) control your real Chrome browser — the one you are already logged into. Not a sandboxed automation browser, not a separate profile: the agent drives the Chrome you use every day, with your actual login sessions, cookies, and SSO state.

The name is a double pun: Ctrl+Shift+I, the DevTools shortcut every developer knows, and Crime Scene Investigation — the AI investigates the scene of your browser.

How it works:
This extension is one half of the system. It connects over WebSocket to a local daemon (a small Go binary, installed separately from the project's GitHub Releases) that listens on 127.0.0.1:10088 only. AI clients send commands to the daemon over plain HTTP; the daemon relays them to this extension, which executes them in your tabs via the Chrome DevTools Protocol debugger API.

What the agent can do in your browser:
- Navigate, find tabs, and read pages as an accessibility tree with stable element references
- Click, fill forms (including contenteditable), type keys, and perform trusted coordinate-level clicks
- Evaluate JavaScript and pass raw CDP commands through to any tab
- Inspect network requests
- Take screenshots and save pages as PDF — files are written to disk by the daemon and returned as paths
- Upload files into file pickers

See what the agent is doing:
Every command carries a session name, and each session's tabs are gathered into a Chrome tab group labeled "agent:<session>". You can watch the agent work in real time — and close the group to stop it.

Security model, stated plainly:
- The daemon binds 127.0.0.1 only. Loopback is the isolation boundary — there is no authentication in v1, so anything running as your user can drive your browser. Install this only if that trade-off is acceptable to you.
- The evaluate and cdp tools are arbitrary code execution channels inside the page. That is a designed capability for agent use, not a bug.
- The extension talks only to the local daemon. It sends nothing to any remote server.

Requirements:
- The companion daemon, installed from the project's GitHub Releases (macOS, Linux, Windows installers provided)
- An AI client: Claude Code skills are installed by the installer, or mount the daemon's built-in MCP server in any MCP-capable client

Open source: full source, protocol documentation, and installers are on GitHub (link in the developer website field).
```

### zh-CN

```
CSI 让 AI agent（Claude Code 或任何支持 MCP 的客户端）控制你真实的 Chrome 浏览器——就是你已经登录着的那个。不是带自动化标记的沙箱浏览器，也不是单独的 profile：agent 直接驱动你每天在用的 Chrome，带着你实际的登录态、cookie 和 SSO 会话。

名字是个双关：Ctrl+Shift+I，每个程序员都按过的 DevTools 快捷键；也是 Crime Scene Investigation——AI 勘查浏览器案发现场。

工作原理：
本扩展是系统的一半。它通过 WebSocket 连接一个本地 daemon（一个小型 Go 二进制，需从项目的 GitHub Releases 单独安装），daemon 只监听 127.0.0.1:10088。AI 客户端通过普通 HTTP 向 daemon 发送命令，daemon 转发给本扩展，扩展通过 Chrome DevTools Protocol 的 debugger API 在你的标签页里执行。

agent 在你的浏览器里能做什么：
- 导航、查找标签页，把页面读成带稳定元素引用的无障碍树
- 点击、填写表单（含 contenteditable）、按键输入，以及可信的坐标级点击
- 执行 JavaScript，向任意标签页透传原始 CDP 命令
- 查看网络请求
- 截图、把页面保存为 PDF——文件由 daemon 写到磁盘，返回文件路径
- 向文件选择器上传文件

看得见 agent 在干什么：
每条命令都带一个 session 名，每个 session 的标签页会被收进一个名为 "agent:<session>" 的 Chrome 标签组。你可以实时看着 agent 工作——关掉标签组即可让它停下。

安全模型，照实说：
- daemon 只绑定 127.0.0.1。回环就是隔离边界——v1 没有鉴权，任何以你的用户身份运行的进程都能驱动你的浏览器。只有在你接受这个权衡时才安装。
- evaluate 和 cdp 工具是页面内的任意代码执行通道。这是为 agent 设计的能力，不是 bug。
- 扩展只与本地 daemon 通信，不向任何远程服务器发送数据。

前置要求：
- 配套 daemon，从项目的 GitHub Releases 安装（提供 macOS、Linux、Windows 安装器）
- 一个 AI 客户端：安装器会装好 Claude Code 技能，或者把 daemon 内置的 MCP server 挂到任何支持 MCP 的客户端

开源：完整源码、协议文档和安装器均在 GitHub（见开发者网站字段）。
```

---

## 4. 分类建议 / Category

**推荐：Developer Tools（开发者工具）**

理由：
1. 用户画像就是开发者——前置依赖是命令行 daemon、Claude Code / MCP 客户端，非技术用户装到一半就会流失，Productivity 分类只会带来差评。
2. 技术实质是 CDP debugger 通道，扩展声明了 `debugger` 权限；Developer Tools 分类下的审核与用户对该权限的心理预期一致。
3. CWS 搜索意图匹配：目标用户会搜 "CDP"、"automation"、"AI agent"、"MCP" 这类词，集中在 Developer Tools 语境。
4. Productivity 里的浏览器自动化同类（如各类 RPA 扩展）面向表单填写/宏录制用户，与 CSI 的"AI 驱动 + 本地 daemon"模式错位。

备选：若后续推出免 daemon 的纯扩展形态（如 DirectCDPBackend 路线之外的轻量模式），再考虑 Productivity。

---

## 5. 语言 / Languages

- English（默认）
- 简体中文

与 `extension/_locales/` 现有语言集一致，不额外增加。

---

## 6. 关键词 / Keywords

供搜索优化与单用途说明（single purpose description）参考：

- 核心：AI agent browser control, CDP, Chrome DevTools Protocol, browser automation, MCP
- 场景：web scraping with login, authenticated automation, screenshot to disk, save page as PDF, e2e testing
- 生态：Claude Code, Model Context Protocol, LLM agent tools

单用途说明（审核用，一句话）：
"CSI lets a user-installed local daemon drive the user's own browser via the CDP debugger API, so AI clients can navigate, read, and act on pages with the user's existing sessions."

---

## 7. 截图说明文字建议 / Screenshot captions

供截图 agent 参考，5 条，按建议排序。每条附中英 caption。

1. **架构总览图**（一张自绘图，非截图也可放第一位）
   - EN: "AI client → local daemon (127.0.0.1 only) → this extension → your real tabs."
   - zh-CN: "AI 客户端 → 本地 daemon（仅 127.0.0.1）→ 本扩展 → 你真实的标签页。"

2. **tab group 可视化**：Chrome 标签条上挂着 `agent:demo` 标签组，组内几个标签页正在变化
   - EN: "Every agent session gets its own tab group — watch it work, close it to stop."
   - zh-CN: "每个 agent 会话都有自己的标签组——实时看它工作，关掉即停止。"

3. **真实登录态**：agent 打开的页面处于已登录状态（如 GitHub 通知页），旁边配 daemon 返回的 snapshot 片段
   - EN: "Your real login sessions — the agent reads pages as you, no separate profile."
   - zh-CN: "使用你实际的登录态——agent 以你的身份读页面，不需要单独 profile。"

4. **截图 / PDF 落盘**：终端里 daemon 返回的截图文件路径 + 访达/资源管理器中生成的文件
   - EN: "Screenshots and PDFs are written to disk by the daemon and returned as file paths."
   - zh-CN: "截图和 PDF 由 daemon 写入磁盘，以文件路径返回。"

5. **popup 与设置页**：popup 显示"已连接"，设置页展示 daemon 状态（PID、版本、端口、会话数）
   - EN: "Connection state and daemon status at a glance — port, uptime, active sessions."
   - zh-CN: "连接状态与 daemon 运行状况一目了然——端口、运行时长、活跃会话。"
