# CSI 隐私政策 / CSI Privacy Policy

最后更新 / Last updated: 2026-03-27

在线版本 / Online version: <https://ximing.github.io/csi/privacy.html>

---

## 中文

### 1. 概述

CSI 是一个开源项目（<https://github.com/ximing/csi>），由两部分组成：一个 Chrome 扩展和一个运行在你自己电脑上的本地 daemon。它的作用是让运行在你本机的 AI 客户端（如 Claude Code）通过本机回环连接操控你真实的 Chrome 浏览器。

**一句话：CSI 不收集、不存储、不传输你的任何数据。**

### 2. 我们不收集什么

CSI 没有遥测、没有分析统计、没有崩溃上报、没有账号系统，也不运营任何远端服务器。扩展和 daemon 都不会向我们（或任何第三方）发送任何数据——我们甚至没有接收数据的服务器。

### 3. 数据如何流动（全部在本机）

- Chrome 扩展只通过 WebSocket 连接本机 daemon（默认 `ws://127.0.0.1:10088/ws`）。
- daemon 只监听 `127.0.0.1`（回环地址），不接受来自本机以外的连接。
- 所有浏览器操作（导航、点击、输入、读取页面、截图、导出 PDF、标签页与标签组管理）都发生在你本机的 Chrome 里，使用你自己已登录的会话。
- 截图与 PDF 由 daemon 写入本机磁盘（默认为系统临时目录，或指令中指定的路径），不会上传。
- 扩展仅使用 `chrome.storage.local` 保存连接设置（daemon 地址、重连周期等），这些数据留在你的浏览器本地配置中。
- daemon 在本机 `~/.csi/` 下写配置、PID 文件和运行日志；日志按天滚动，最多保留 3 天。

### 4. 第三方 AI 客户端

向 daemon 发出指令的是你自己在本机运行的 AI 客户端（例如 Claude Code）。页面内容、截图路径等工具结果会返回给该客户端；**该客户端可能会按其自身隐私政策把内容发送到它自己的云端服务**。这属于 AI 客户端的行为，不在 CSI 的控制范围内——请同时阅读你所用 AI 客户端的隐私政策。

### 5. 扩展权限说明

- `debugger`：通过 Chrome DevTools Protocol 在页面内执行工具（读取、点击、截图等）。
- `tabs` / `activeTab` / `tabGroups` / `windows`：标签页、标签组与窗口管理。
- `storage`：保存扩展的本地连接设置。
- `alarms`：断线重连的看门狗定时器。
- `host_permissions: <all_urls>`：只有在收到你的指令时才会操作对应页面；扩展不会主动访问任何网站。

### 6. 安全边界

v1 的 daemon 无鉴权，回环地址就是唯一的隔离边界：任何以你的用户身份在本机运行的进程都可以向 daemon 发指令、驱动你的浏览器。请据此决定在本机运行哪些程序。

### 7. 数据留存与删除

我们不持有你的任何数据，因此无从删除。本机产物（截图、PDF、日志、配置）都在你自己的磁盘上，删除对应文件即可；卸载扩展会清除其 `chrome.storage.local` 中的设置。

### 8. 政策变更与联系

本政策随仓库更新，变更以 git 历史为准。问题与反馈请提交 GitHub Issue：<https://github.com/ximing/csi/issues>。

---

## English

### 1. Overview

CSI is an open-source project (<https://github.com/ximing/csi>) consisting of a Chrome extension and a local daemon running on your own machine. It lets AI clients running locally on your computer (such as Claude Code) drive your real Chrome browser over a loopback connection.

**In one sentence: CSI does not collect, store, or transmit any of your data.**

### 2. What we do not collect

CSI has no telemetry, no analytics, no crash reporting, no accounts, and no remote servers. Neither the extension nor the daemon sends any data to us (or to any third party) — we do not even operate a server that could receive it.

### 3. How data flows (entirely on your machine)

- The Chrome extension connects only to the local daemon over WebSocket (default `ws://127.0.0.1:10088/ws`).
- The daemon listens on `127.0.0.1` (loopback) only and accepts no connections from outside your machine.
- All browser actions (navigate, click, type, read pages, screenshots, save-as-PDF, tab and tab-group management) happen inside your own Chrome, using your own logged-in sessions.
- Screenshots and PDFs are written to your local disk by the daemon (the system temp directory by default, or a path given in the command). They are never uploaded.
- The extension stores only connection settings (daemon URL, reconnect interval, etc.) in `chrome.storage.local`, which stays inside your browser profile.
- The daemon writes its config, PID file, and runtime logs under `~/.csi/` on your machine; logs rotate daily and are kept for at most 3 days.

### 4. Third-party AI clients

Commands are sent to the daemon by AI clients that you run locally (e.g., Claude Code). Tool results such as page content or screenshot file paths are returned to that client; **the client may transmit this content to its own cloud service under its own privacy policy**. That is the AI client's behavior and is outside CSI's control — please also read the privacy policy of the AI client you use.

### 5. Extension permissions

- `debugger`: executes tools inside pages via the Chrome DevTools Protocol (read, click, screenshot, etc.).
- `tabs` / `activeTab` / `tabGroups` / `windows`: tab, tab-group, and window management.
- `storage`: stores the extension's local connection settings.
- `alarms`: watchdog timer for reconnecting to the daemon.
- `host_permissions: <all_urls>`: pages are only ever acted upon when you (via your AI client) command it; the extension never visits any site on its own.

### 6. Security boundary

The v1 daemon has no authentication; the loopback address is the only isolation boundary. Any process running as your user on your machine can send commands to the daemon and drive your browser. Choose what you run locally accordingly.

### 7. Retention and deletion

We hold none of your data, so there is nothing for us to delete. Local artifacts (screenshots, PDFs, logs, config) live on your own disk — delete the files to remove them. Uninstalling the extension clears its settings from `chrome.storage.local`.

### 8. Changes and contact

This policy is maintained in the repository; see git history for changes. Questions and feedback: GitHub Issues at <https://github.com/ximing/csi/issues>.
