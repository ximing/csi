# cdp-bridge

让 AI（Claude Code 之类的 agent）直接控制你自己在用的 Chrome：导航、点击、输入、读页面、截图——用的是你真实的登录态，不是另起一个干净的自动化浏览器。

## 构想

```
AI 客户端 ──HTTP──▶ 本地 daemon (Go) ◀──WebSocket── Chrome 扩展
```

- daemon 跑在本机，只监听 127.0.0.1，对 AI 客户端暴露简单的 HTTP API。
- 扩展装在日常用的 Chrome 里，主动连 daemon，通过 CDP debugger API 操作 tab。
- 每个命令带一个 session 名，同一 session 的 tab 之后归成一组，方便看清 AI 在干嘛。

## 状态

刚开了个头，先把 daemon 骨架搭起来，协议边写边定。
