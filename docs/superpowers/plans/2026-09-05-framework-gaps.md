# 框架缺口修复

日期: 2026-09-05
状态: 执行中
分支: `fix/framework-gaps`
工作树: `.worktrees/fix-framework-gaps`

只修分析里筛过的四条真问题，不碰已做成的隔离能力，不加鉴权，不加 `tool_cancel`，不做对话框/跨域 iframe/DirectCDP。

## Global Constraints

- **协议先行**：任何 HTTP 字段、session 回收语义、upload selector 语义、MCP 超时语义的变更，先改 `docs/protocol.md`，再改实现。工具清单仍是 21 个，不增不减。
- **TDD**：实现任务必须先写失败测试、看它因缺功能失败、再写最小实现。协议-only 的 Task 1 不跑 TDD。
- daemon 注释中文，引用协议写 `协议 §x.y`。commit message 中文、随意。
- 安全边界不动：只绑 `127.0.0.1`，v1 无鉴权。
- `_` 前缀字段仍只由 daemon 注入。
- upload **不加** `frame` 参数（协议 §4 八个带 frame 的工具名单不变）。`@e` 自带 frameId。
- 不要改许可证、不要做 AGPL、不要把 README 改成 brew 优先。
- 测试：daemon `cd daemon && go test ./...`（任务范围内包可先跑，提交前跑全量）；扩展只跑触及的 vitest 文件。
- 工作目录必须是本 worktree，不要改主工作树 `master`。

## 背景（四条真问题）

1. `upload` 协议/技能写 selector 一律 `@e` 或 CSS，实现只走顶层 `DOM.querySelector`。
2. Homebrew formula 注入 `CSI_BREW_SERVICE=1` 且 caveats 声称 CLI 会拒绝 `csi stop`，Go 没读这个变量；`POST /restart` 仍 `spawnReplacement`，和 KeepAlive 抢端口。
3. session 账本只在内存。`csi update` / `POST /restart` / 24h TTL / LRU 丢掉映射，Chrome 里 `agent:*` 组还在；规格写「回收无副作用走 stale_target」不成立。
4. `csi mcp` HTTP client 写死 130s，跟后来可配的 `tool_timeout_seconds`（5–600）没对齐。

---

## Task 1: 协议契约

只改 `docs/protocol.md`（本任务不要改 Go/TS）。

### §2.2 `GET /status`

在现有 JSON 示例后补：当且仅当 daemon 进程环境变量 `CSI_BREW_SERVICE=1` 时多一个字段 `"supervisor": "brew-services"`；否则**省略**该字段（不要发空字符串）。旧客户端忽略未知键。说明：`csi stop` / `csi restart` 看到此字段必须拒绝并提示 `brew services stop|restart csi`，`--force` 同样拒绝。

### §2.6 `POST /restart`

补一句：`supervisor` 为 `brew-services` 时只优雅退出、**不**拉起替代 `serve` 进程，由 Homebrew KeepAlive 拉起新进程读新 config；其它通道保持今天的 spawn + 退出。

### §3.3 工具超时（或 §2 末）

补一句：`csi mcp` 转发 `POST /command` 时，其 HTTP 客户端超时为当前生效的 `tool_timeout_seconds` + 10s（读 `GET /config`），不是写死 130s。`/config` 不可达时回退 130s。

### §3.4 session 状态

补两段实现语义（这是可观察行为，必须进契约）：

1. **持久化**：daemon 把 `{session → {tabIds, currentTabId, borrowed, groupTitle}}` 写到运行目录 `sessions.json`（与 `config.json` 同级，即 `~/.csi/sessions.json`）。进程启动时加载；文件缺失或损坏则空表启动。加载后的 session 视为刚访问（不立刻 TTL）。
2. **回收**：24h IdleTTL 与 256 LRU **不得**淘汰仍有 owned tab（`tabIds` 非空）的 session。空 owned 集且未持锁的才可淘汰。LRU 找不到空 session 受害者时跳过淘汰（允许暂时超过 256）。淘汰空 session 仍无副作用。

### §4 `upload` 行

备注写明：`selector` 为 CSS 或 `@e`（与表头一致）；`@e` 走 ref 表（可在 iframe）；CSS 仍只打顶层文档（本工具无 `frame` 参数）。

提交：单独 commit，例如 `协议：supervisor、session 落盘、upload @e、MCP 超时`。

---

## Task 2: upload 支持 @e

文件：

- `extension/src/background/tools/upload.ts`
- `extension/src/background/tools/upload.test.ts`
- `skills/csi/references/interaction.md`（upload 那一行补 `@e`）

实现：

- `selector` 经 `resolveObjectId(this.name, selector, target.tabId)`（与 click/fill 相同）。
- `DOM.setFileInputFiles` 用 `{ files, objectId }`，不再 `DOM.getDocument` + `querySelector` + `nodeId`。
- 缺 selector 文案改为 `upload: selector is required (CSS selector or @e ref)`。
- 不加 `frame` 参数。

TDD：

1. 先加 `@e` 路径测试（`assignRef` + `DOM.resolveNode` 返回 objectId，断言 `setFileInputFiles` 带 `objectId`、**没有** `querySelector`），确认当前实现失败。
2. 再改实现。
3. 改现有 CSS 成功/未命中测试：CSS 走 `Runtime.evaluate`（`element.ts` 的 `objectIdFromCss`），未命中仍是 `upload: element not found: …`。

测试命令：`cd extension && npx vitest run src/background/tools/upload.test.ts`

提交：`upload 支持 @e ref`

---

## Task 3: session 落盘 + 有 owned tab 不淘汰

文件：

- `daemon/internal/session/session.go`
- `daemon/internal/session/session_test.go`（可新 `persist_test.go`）
- `daemon/internal/server/server.go`：`New` 用带落盘的 Manager（`dir` 已传入）

API：

- `NewManager()` 保持纯内存（现有测试不改行为）。
- 新增 `NewManagerPersist(dir string) *Manager`：从 `filepath.Join(dir, "sessions.json")` 加载；之后 `Update` / `ForgetTab` / 会改 GroupTitle 的 `Inject` 写回。`Acquire` 不需要写盘。
- 写盘：临时文件 + `Rename`；只持久化 `tabIds/currentTabId/borrowed/groupTitle`，不写 gate。损坏文件当空表。
- `sweepLocked`：`len(s.TabIDs) > 0` 的跳过（busy 仍跳过）。
- `evictLRULocked`：只在 `len(TabIDs)==0 && !busy` 里挑 LRU；没有受害者则 no-op。

`server.New` 改成 `session.NewManagerPersist(dir)`。现有 `session` 单测继续用 `NewManager()`。

TDD 顺序：

1. Persist round-trip：`Update navigate tabId=10` → 新 Manager 从同一 dir 加载 → `Inject` 得到 `_tabId==10` 且 owned。
2. TTL：owned 非空的 session 即使 lastAccess 很旧也不 sweep。
3. LRU：256 个空 session 仍淘汰空的；有 owned 的不被淘汰。

`cd daemon && go test ./internal/session/ ./internal/server/`

提交：`session 落盘，有 owned tab 不回收`

---

## Task 4: Homebrew supervisor

对照 `docs/superpowers/specs/2026-08-31-homebrew-agpl-design.md` 的「brew 生命周期与 daemon 行为」，**只做 Go/文档，不做 AGPL、不改 formula 模板**（模板已经有 `CSI_BREW_SERVICE: 1`）。

### daemon HTTP

- `server.Server` 增加 `Supervisor string`（空 = 省略）。
- `handleStatus`：非空则输出 `"supervisor":"<值>"`。
- `cmdServe`：`os.Getenv("CSI_BREW_SERVICE") == "1"` 时 `srv.Supervisor = "brew-services"`。
- `Restarter`：brew 通道只 `restartCh <- struct{}{}`，**禁止** `spawnReplacement`。非 brew 保持现状。
- brew `serve` 启动时幂等 `autostart.Disable(userHome)`（`os.UserHomeDir()`，不是 CSI_HOME）；失败只打日志。用可注入的函数方便测，禁止单测去碰本机 LaunchAgents。

### CLI

- `statusReply` 增加 `Supervisor string \`json:"supervisor,omitempty"\``。
- `fetchStatus` 解析该字段。
- `decideStop`：`st != nil && st.Supervisor == "brew-services"` → 新决策 `stopRefuseBrew`（即使 pid 匹配）。
- `stopDaemon`：此决策打印明确错误（指向 `brew services stop|restart csi`）并 `error` 非 nil，不发信号。`--force` 同样拒绝（在 `force==true` 之前先看 supervisor；或 force 路径也 fetch status）。
- `cmdRestart`：若 `/status.supervisor == brew-services`，直接同样错误，不要 stop+start。

### 文档

- `daemon/CLAUDE.md`：补 `CSI_BREW_SERVICE`、`/status.supervisor`、brew 禁止 spawn。
- `skills/csi/references/operations.md`：`/status` 字段表加 `supervisor`；Do-not-run 加上 `brew services stop/restart`；若 `csi stop`/`restart` 输出要求 brew，把命令告诉用户，**不要自己执行** `brew services *`。

TDD：

- `internal/server`：默认 `/status` 无 supervisor；`Supervisor="brew-services"` 时有。
- `cmd/csi`：`decideStop` brew 拒绝；`fetchStatus` 解析 supervisor。
- Restarter 分支：env 置位不 spawn（可把 Restarter 装配逻辑抽成纯函数测，或小函数 `brewSupervised() bool` + `restartSpawnsReplacement(brew bool) bool`）。

`cd daemon && go test ./internal/server/ ./cmd/csi/`

提交：`brew 通道认 supervisor，stop/restart 拒绝`

---

## Task 5: MCP 超时跟 /config

文件：`daemon/internal/mcp/forward.go`、`mcp_test.go`（或 `forward_test.go`）。

- 抽出 `httpTimeout(toolTimeoutSec int) time.Duration` = `(toolTimeoutSec + 10) * time.Second`；非法/0 则 130s。
- `forwarder` 在发 `/command` 前 `GET {baseURL}/config`，读 `tool_timeout_seconds.value`（整数）。失败则 130s。
- `http.Client{Timeout: httpTimeout(...)}` 按这次读到的值建（或缓存但测试要能覆盖「config 变了」——允许每次 call 读一次 /config，简单正确）。

TDD：

1. `httpTimeout(60) == 70s`，`httpTimeout(0)==130s`。
2. httptest：`/config` 返回 `{"tool_timeout_seconds":{"value":60,"source":"config"}}`，`/command` 记录请求；一次 MCP 工具调用后，client 使用 70s（可导出 timeout 或通过自定义 Transport/短 deadline 验证读到了 60）。至少断言 forwarder 向 `/config` 发了 GET 且用了 60。

不要用 70s 真实 sleep。

`cd daemon && go test ./internal/mcp/`

提交：`mcp 超时跟 tool_timeout_seconds`

---

## 完成标准

- 四处工具清单不变。
- `cd daemon && go test ./...` 绿。
- `cd extension && npx vitest run src/background/tools/upload.test.ts` 绿。
- 协议与实现一致。
