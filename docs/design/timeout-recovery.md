# 工具超时后的执行与恢复语义

日期：2026-09-30
状态：设计提案，尚未实现。本文中的新字段、端点和 WS 消息不是当前协议。现行契约仍以 [protocol.md](../protocol.md) 为准。

## 1. 当前行为与问题

- `ws.Hub.CallTool` 发送请求后开始计时；到期或 HTTP context 取消就删除 pending 并返回。计时不包含先前的 session 排队。
- 扩展收到 `tool_call` 后自行执行；协议没有取消消息。daemon 超时不意味着点击、导航、脚本执行已停止。
- 扩展 `enqueueTab` 在工具 Promise 真正结束后才放行后续任务，这是必须保留的互斥边界。
- daemon 的 session 锁随 Execute 返回而释放；迟到结果因 pending 已删除而不再更新 session，也不做结果落盘。
- 断线时扩展只向原连接回复，不能把旧结果无身份校验地发给新连接。

具体后果：navigate 在 daemon 超时后创建了标签，daemon 可能不知道这个标签属于哪个 session；提交表单超时后自动重试，可能重复提交。不能用“超时即失败、失败即重试”描述这类操作。

## 2. 选择

采用“操作记录 + 独立等待 + 可查询结果”，然后逐步加入协作式取消。

| 方案 | 取舍 |
|---|---|
| 仅增加超时错误码 | 成本小，但不能找回迟到结果、阻止重复执行或恢复 session |
| 超时就 detach / 关闭标签 | 无法撤销已产生的网页副作用，还会破坏用户页面和其他任务，不采用 |
| 持久化操作身份，等待与执行分离 | 可恢复和去重，增加一个操作管理模块；推荐 |

不承诺网页副作用 exactly-once。能保证的是：记录保留期间，同一个操作身份不会被 CSI 主动重复派发；连接或进程丢失导致的不确定状态会明确暴露。

## 3. 身份与状态

新模式由客户端显式传顶层 `operationId`（UUID）启用，原有未传字段的请求维持旧行为。身份作用域是当前 daemon 安装，不按 session 重复使用。

操作记录至少包含：operationId、action、session、规范化 args 摘要、创建时间、目标 tab、扩展实例身份、状态、派发阶段、结果/错误、状态更新时间。摘要使用参数对象递归排序后的 JSON；session 默认值先归一化，服务端注入字段不参与摘要，客户端伪造 `_` 字段按现行规则覆盖。

相同 ID + 相同请求：返回记录或加入等待，绝不重发；相同 ID + 不同 action/session/args：`operation_conflict`。

| 状态 | 含义 | 是否允许再次派发原操作 |
|---|---|---|
| queued | daemon 已接收，尚未交给扩展 | 仅原任务可继续；重复请求不新增任务 |
| dispatched | 派发意图已持久化，尚未收到扩展开始确认 | 不允许 |
| running | 扩展已确认开始执行 | 不允许 |
| succeeded | 扩展成功，结果已落盘且 session 已对账 | 不允许，直接返回结果 |
| failed | 工具执行已结束且报错，或确定未派发的准备阶段失败；不保证此前无副作用 | 不允许，直接返回错误 |
| cancelled | 确认尚未执行或执行已停止；是否有部分副作用单独说明 | 不允许 |
| unknown | 是否执行完、是否产生副作用无法确认 | 不允许 |

`wait_timeout` 是一次等待的返回原因，不是操作状态。`cancelRequested` 是标记，不是“已取消”。

状态必须带单调 revision，重复/乱序确认不能覆盖终态。来自错误 operationId、错误扩展实例或已作废连接的结果不得直接接受；重连结果须经过恢复握手。

## 4. HTTP 与 MCP 提案

- `POST /command` 保留 action/session/args，增加可选 `operationId` 和 `waitTimeoutMs`。
- 新模式的成功响应保留现有 data；增加 operationId/state。等待期限到达返回 `success:false, code:"wait_timeout", details:{operationId,state}`，操作仍可继续。
- `waitTimeoutMs` 从请求接收起覆盖排队、执行和落盘；范围 1–600000ms，缺省采用现行 tool_timeout_seconds。客户端断开只移除等待者，不取消已接收操作。
- `GET /operations/{operationId}` 返回状态及已保存的最终结果；查询不受 session FIFO 阻塞。
- `POST /operations/{operationId}/cancel` 请求取消，返回当前状态和 cancelRequested；不能把接受请求当成取消成功。
- 未知或已清理 ID 返回 `operation_not_found`，不能据此断言从未执行过。保留期限外禁止自动重试旧 ID。
- 新端点沿用现有 API 鉴权；不修改监听和认证默认值。
- MCP 新增操作查询/取消能力，在服务端声明支持后才暴露。代理为每次工具调用生成 operationId，在超时结果中原样展示；只有显式携带同一 ID 才能跨 MCP 调用去重，不能靠参数相同猜测重试。

示例：调用返回 wait_timeout 后，客户端查询原 ID；若 running 则继续等待，若 succeeded 则消费原结果。不得生成新 ID 再次点击“付款”。failed / cancelled 也可能已有部分副作用，是否发起新操作需要结合工具结果和页面状态决定。

## 5. 执行、排队与持久化

在 daemon 新增 operations 模块，负责记录、去重、等待者和后台任务；HTTP handler 仅接收与等待。Hub 继续负责传输，不承担业务状态机。

1. 原子创建 queued 记录并落盘，成功后才确认接收。记录失败则不派发。
2. 操作自己的 context 获取 session FIFO 锁；不使用 HTTP 请求 context 作为执行 context。
3. 获取当前目标并注入参数，保存派发意图和目标，再发 WS。写入成功与网络发送之间的崩溃空隙按 unknown 处理，不能猜测“没有发送”。
4. 扩展接收 operationId、对重复 ID 去重，并在进入实际执行前确认 running；同一标签沿用现有队列。
5. daemon 持久化原始终态结果，按 operationId 幂等更新 session，再落盘 artifact，最后发布客户端可见终态。
6. 只有终态对账完成后才释放 session gate。等待超时不释放该 gate。不同 session 仍可并行，同 tab 仍受扩展队列约束。

终态处理用可重放的 journal 阶段记录（received / session_applied / artifacts_saved / published）。重启后重放尚未完成的对账；session 更新必须对同一 operationId 幂等。关闭、navigate 和 borrowed 状态按现行规则更新。artifact 使用稳定的操作目录/临时文件并原子改名，重放不新建重复产物。

如果扩展成功但本地落盘失败，保留 received 阶段与重试错误，操作保持未发布状态；查询显示 `phase:"finalizing"`。不能重跑浏览器工具以修复磁盘错误。

资源上限（初始建议）：最多 256 个未完成操作；满时拒绝新操作，重复 ID 查询不受影响。终态结果保留 24h，结果存储总预算 256MiB；提前回收大结果时保留 ID/摘要/终态墓碑至 24h，返回 `result_expired` 而非重执行。未完成与 unknown 记录不因 TTL 自动删除。原始 args 如需持久化必须使用仅运行用户可读的文件；结果大小仍服从现有传输上限。

## 6. 取消的真实边界

- queued：在发送前原子标记 cancelled，确认没有执行。
- dispatched：只能请求取消；必须由扩展确认未执行或已停止才能变为 cancelled。
- running：工具可通过 AbortSignal 停止下一次轮询、下一条 CDP 指令和等待监听器；取消确认同时说明可能已执行的部分。
- 已发出的 click、Page.navigate 或 Runtime.evaluate 不保证可撤销。无法证明停止时，保持 running；连接或执行身份丢失才进入 unknown。
- 取消和完成竞争时，以扩展确认的执行事实为准；若已完成，返回原成功/失败结果。
- 不通过删除标签队列、detach debugger 或关闭用户标签来伪造“取消完成”。长时间无法停止的操作持续占用对应 gate，并在查询中解释阻塞原因。

现有 tool_timeout_seconds 在新模式中仅控制默认等待期限，不作为副作用终止保证。navigate/wait 等工具内部的超时仍是工具执行逻辑；返回失败同样不能证明所有已发出的浏览器动作都被撤销。

## 7. 断线、重连与重启

扩展为每次 worker 实例生成 executionInstanceId，并在存活期间保留操作表。新 WS 连接通过 capability 握手报告实例身份和可恢复操作；daemon 再请求对应结果，避免旧连接结果污染新连接。

- WS 断开但 worker 未重启：操作先标 unknown 并保留 gate；验证同一实例的操作记录后恢复 running 或终态，恢复结果不重新执行工具。
- worker 已重启：旧 JS Promise 和内存去重表不能被假定仍在。未对账操作保持 unknown；不能根据“新 worker 没记录”得出从未执行。
- daemon 重启：加载 journal；queued 且确定未派发可继续排队，已派发记录先置 unknown，再与扩展对账。
- 浏览器重启：tab ID 属于旧浏览器生命周期，不自动绑定到新 tab；相关记录标 unknown，旧 session 目标需显式重新建立。
- unknown 对应的 session 禁止继续派发；已知 tab 还须在 daemon 侧登记阻塞，阻止其他 session 经 borrowed 路径绕过。新建 tab 结果未知时，至少阻塞原 session，报告可能存在未收养标签。

无法自动对账时，由用户检查网页实际结果，再选择终止相关页面/操作并明确放弃恢复。未来可提供 `POST /operations/{id}/acknowledge-unknown`：只在确认原执行已结束或原浏览器实例已退出后释放阻塞，记录操作者选择；不把 unknown 改成 succeeded/cancelled，不重新派发旧 ID。确认放弃后记录 recoveryAcknowledged，不再占用未完成操作配额，但仍保留 unknown 身份墓碑到保留期结束。单纯“忽略错误继续”不能解锁仍可能运行的标签。

## 8. 兼容与实施顺序

1. 先在现行文档解释超时不等于停止（本次交付）；不增加任何新错误码或端点。
2. 下一次协议变更先更新 protocol.md，定义 capability `operation_recovery_v1`、HTTP 形状、WS 确认/查询/恢复消息及实例身份。
3. 实现 daemon journal、后台执行、等待分离和查询；扩展实现操作表/去重/恢复。新模式仅在双方握手支持时接受，否则明确 `unsupported_capability`，禁止静默降级。
4. 接入 MCP、技能说明和客户端查询流程；旧客户端仍沿用原 HTTP 信封和超时行为。
5. 最后逐工具接入取消。先支持尚未派发的取消，再支持 wait 的协作停止；不为不可撤销工具宣称强取消。

每阶段单独实现和评审。具体接口与资源默认值在协议落地时接受最终评审，本次不修改线上契约的执行行为。

## 9. 必须通过的验收场景

- HTTP 等待超时或客户端断开后，原操作继续执行且结果可查询，session 仍最终收养新 tab。
- 同一 ID 并发请求只派发一次；不同 payload 复用 ID 被拒绝。
- 超时后不同 ID 的同 session 操作继续排队；取消等待者不放开 gate。
- queued 取消确认零派发；running 取消不能报告未经确认的停止。
- 成功和取消竞争不覆盖真实终态；迟到/重复结果不重复更新 session 或写 artifact。
- 断线后同一 worker 恢复结果；worker/daemon/browser 重启分别按上述边界恢复或进入 unknown。
- unknown 阻止同 session 和已知同 tab 的跨 session 操作；用户确认流程不伪造终态。
- journal 写失败不派发；落盘中断可恢复；结果过期只返回 result_expired，不重新执行。
- 老扩展与新 daemon、新扩展与老 daemon 均不误启用恢复模式；现行测试保持通过。
