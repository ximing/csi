# 扩展设置页（Options Page）设计

日期：2026-03-09
状态：已确认

## 背景与目标

目前插件只有一个 popup：连接状态圆点 + daemon WS URL 输入框 + 连接/断开/测试按钮。daemon 的 `/status` 已返回丰富信息（pid、版本、uptime、会话、扩展连接状态），但用户无从查看；daemon 端口只能通过 `CSI_PORT` 环境变量临时覆盖，没有持久化配置。

目标：新增独立的 options 设置页，支持：

1. 查看本地守护进程状态
2. 修改 daemon 端口（落盘 + 一键自重启生效）
3. 修改日志保留天数（当前硬编码 3 天）
4. 修改工具调用默认超时（当前硬编码 120s）
5. 修改插件自动重连周期（当前硬编码 30s）

不做：开机自启 daemon（平台差异大，另行立项）。

## 总体架构

```
options 页面（新）                daemon（Go）
┌─────────────────┐   HTTP     ┌──────────────────────────┐
│ 状态区块         │ ─────────▶ │ GET /status（已有）       │
│ 端口/日志/超时    │ ─────────▶ │ GET/POST /config（新增）  │
│ 一键重启         │ ─────────▶ │ POST /restart（新增）     │
└─────────────────┘            │ ~/.csi/config.json（新增）│
        │                      └──────────────────────────┘
        │ chrome.storage / runtime message
        ▼
background（重连周期、WS URL 切换、WS 连接状态）
```

- manifest 增加 `options_ui`，popup 底部加「设置」链接调 `chrome.runtime.openOptionsPage()`。popup 本身保持轻量，不内嵌设置。
- options 页直接 `fetch http://127.0.0.1:<port>/...`（`host_permissions: <all_urls>` 已覆盖 loopback），不经 background 中转。
- 插件侧设置（重连周期、WS URL 切换）走 `chrome.storage`，background 监听 `storage.onChanged` 响应。

## daemon 侧改动

### config.json

新增 `~/.csi/config.json`：

```json
{ "port": 10088, "log_retention_days": 3, "tool_timeout_seconds": 120 }
```

- 文件不存在或字段缺失时用默认值补齐；非法值视为缺失。
- 端口优先级：`CSI_PORT` 环境变量 > config.json > 默认 10088（env 保留为临时覆盖手段，向后兼容）。
- **只有 port 保留 env 覆盖**；`log_retention_days` / `tool_timeout_seconds` 只走 config.json，不加 env 路径。

### 新 HTTP 端点

- `GET /config` — 返回当前生效值及每项来源：

```json
{
  "port": { "value": 10088, "source": "default" },
  "log_retention_days": { "value": 3, "source": "config" },
  "tool_timeout_seconds": { "value": 120, "source": "default" }
}
```

`source` 取值 `env` / `config` / `default`。

- `POST /config` — 请求体为要修改的字段子集。校验规则：端口 1–65535；保留天数 1–30；超时 5–600 秒。校验失败返回错误说明（HTTP 200 + `{success:false}`，与 `/command` 风格一致）。成功后：
  - `log_retention_days`：落盘即生效（下次日志清理按新值）。
  - `tool_timeout_seconds`：落盘并即时写 `Hub.ToolTimeout`。
  - `port`：仅落盘，响应带 `"restart_required": true`。
  - 端口被 `CSI_PORT` 覆盖时拒绝修改端口字段并说明原因。

- `POST /restart` — daemon 自重启。不能复用 `startDaemon()` 的 already-running 检查（存活进程就是自己，会被判成 startAlready），只复用其 detached 启动部分（`detachProc` + 日志重定向 + `cmd.Env`）拉起新 `serve` 进程，随后**立即返回** `{success:true}` 并退出。就绪确认由调用方轮询 `/healthz` 完成（options 页已实现该轮询）。为支持「端口不变也重启」，`cmdServe` 的监听需加 bind 重试：`EADDRINUSE` 时按 200ms 退避重试最多 10s，等旧进程释放端口；超时仍失败则记日志退出。

### logrotate 参数化

`logrotate.go` 的保留天数从硬编码 3 改为启动时从 config 读取；`POST /config` 修改后更新内存中的值。

## 插件侧改动

### 入口

- `manifest.json` 增加：
  ```json
  "options_ui": { "page": "options.html", "open_in_tab": true }
  ```
- popup 底部加「设置」链接 → `chrome.runtime.openOptionsPage()`。
- vite 构建增加 options 入口。

### options 页面结构

`options.html` + `options.ts` + `options.css`，视觉风格沿用 popup；文案走现有 `_locales`（en / zh_CN 双语）。三个区块：

**1. 守护进程状态**（每 3s 轮询 `/status`）

显示：运行状态、PID、daemon 版本、已运行时长、监听端口、已连接扩展版本、活跃会话列表。
daemon 不可达时显示「未运行」+ 终端启动提示（`csi start`），其余设置区块禁用。

**2. 守护进程设置**

三个字段：端口号、日志保留天数、工具默认超时（秒）。
- 打开页面时 `GET /config` 填充当前值；`source === "env"` 的字段输入框禁用并标注「被环境变量 CSI_PORT 覆盖」。
- 「保存」调 `POST /config`。
- 端口变更后显示「重启生效」按钮：点击 → `POST /restart` → 轮询**新端口** `/healthz`（每 500ms，最多 10s）→ 成功后把 `chrome.storage` 的 `local_url` 更新为 `ws://127.0.0.1:<新端口>/ws`，并给 background 发消息触发重连。
- 重启轮询超时：先探测旧端口 `/healthz`——旧端口还活着则提示「重启失败，daemon 仍在原端口运行」且不切换 URL；旧端口也不通则提示查看 `~/.csi/logs`。

**3. 插件设置**

自动重连周期：下拉框 10s / 30s（默认）/ 60s / 关闭。存 `chrome.storage`（新 key `reconcile_period_seconds`），background 监听 `storage.onChanged` 重建 reconcile alarm；选「关闭」则取消 alarm（`ws_should_connect` 语义不变，仅不再周期性重连）。

### 版本兼容

daemon 过旧没有 `/config` 端点时（404），「守护进程设置」区块显示「需要 daemon ≥ 0.3.0」并禁用；状态区块仍可用。

## 错误处理汇总

| 场景 | 行为 |
|---|---|
| daemon 未运行 | 状态区块显示未运行 + 启动提示，设置区块禁用 |
| 端口被 env 覆盖 | 端口输入框禁用并标注 |
| 输入非法 | 前端先校验；daemon 为最终权威校验，错误透传显示 |
| 重启后新端口不可达 | 探测旧端口，按上文分支提示，不盲目切换 URL |
| 旧 daemon 无 /config | 设置区块提示需升级 daemon |

## 测试

daemon（Go 单测，沿用现有风格）：

- config 读写：缺文件/缺字段/非法值的默认值合并
- `CSI_PORT` 优先级高于 config.json
- `POST /config` 校验边界（端口 0/65536、天数 0/31、超时 4/601）
- logrotate 按参数化天数清理
- 自重启集成测试：起真实 `serve` 进程 → `POST /restart` → 轮询 `/healthz` 断言新 pid、新端口可达；含「端口不变重启」用例（bind 重试生效）

插件：

- `npm run typecheck` + `npm run build` 通过
- 手动验收（可用 csi 自身能力驱动）：打开 options 页 → 状态正确显示 → 改超时即时生效 → 改端口 + 一键重启 → 插件自动重连到新端口

文档：

- `docs/protocol.md` 补充 `/config`、`/restart` 端点与 config.json 说明
- README 提及设置页入口
