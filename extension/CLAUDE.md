# extension 目录说明

## 这个目录负责什么

Chrome MV3 扩展（TypeScript）：作为 WS **客户端**主动连 daemon，在真实 Chrome 里通过 CDP debugger API 执行协议 §4 的 17 个工具。

## 结构

- `src/background/` — service worker 主体
  - `index.ts` — 入口；`ws-client.ts` — 连 daemon 的 WS 客户端（自动重连）
  - `registry.ts` — 工具注册表 + 分发；`SESSION_SCOPED_TOOLS`（`close_tab`/`list_tabs`/`close_session`）自己消费 `_tabId`，其余工具先 attach 到 `_tabId` 指向的 tab
  - `tools/*.ts` — 一个工具一个文件一个类，实现 `tools/types.ts` 的 `Tool` 接口（`name` + `execute(args)`）
  - `debugger-session.ts` / `tab-manager.ts` / `tab-group.ts` / `refs.ts` — CDP attach、当前 tab 追踪、`agent:<session>` tab group、`@e` 引用
- `src/popup/` — popup 页（连接状态、端口配置）
- `src/shared/` — 与 daemon 协议相关的消息类型与常量
- `dist/` — **构建产物**，在 `chrome://extensions` 里 load unpacked 的就是它；不要手改

## 放置约束

- 新工具：在 `src/background/tools/` 新建实现 `Tool` 的类，并在 `registry.ts` 的 `registerAllTools()` 里注册；若是管理 tab 自身的工具，同时加进 `SESSION_SCOPED_TOOLS`。
- 工具参数里 `_` 前缀字段（`_session`/`_tabId`/`_tabIds`）由 daemon 注入，按协议 §3.4 消费，不要当成普通业务参数。
- 文件头注释说明工具语义并引用协议章节（如 `protocol §4.1`）。

## 开发偏好

- 构建：`npm run build` → 在 `chrome://extensions` 点 reload，popup 显示 connected 才算就绪。
