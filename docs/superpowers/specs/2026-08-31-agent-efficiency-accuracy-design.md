# Agent token 效率与识别准确率改造设计

日期：2026-08-31
状态：待审查
适用范围：daemon / extension / skills / Codex plugin

## 背景

CSI 0.6 已经具备真实 Chrome 登录态、session 标签组、compact YAML snapshot、`@e` 引用、同源 iframe、等待与网络检查等能力。当前主要瓶颈不再是缺工具，而是两类系统性成本：

1. extension 用全局可变状态表示当前 CDP target、ref 表和 frame context。在多 tab、多 session 或并行调用下，Agent 可能拿着正确的意图操作错误页面或失效元素。
2. Agent 每次触发 CSI 都要加载较长的操作手册；snapshot 和部分逃生工具又能返回大结果，造成固定 token 成本与长尾输出膨胀。

本设计先保证“目标是谁”始终确定，再减少提示词与结果体积。不能用更短但更含糊的返回换 token，也不能靠技能文字掩盖实现状态机的问题。

## 当前基线

### 技能成本

`skills/csi/SKILL.md` 当前约为：

- 17,780 bytes
- 16,908 个 Unicode 字符
- `cl100k_base` 下约 4,880 tokens

主文件同时包含 21 个工具、HTTP/curl、Windows 请求体、session、iframe、截图/PDF、输入、等待、键盘和 daemon 恢复流程。`references/operations.md` 已经证明按需加载可用，但大部分长尾说明仍在主文件。

### 结果成本

- snapshot compact/interactive 默认 `max_chars=24000`，最大 80000。
- snapshot full 忽略 `max_chars`，返回完整 JSON 树。
- network list 返回捕获表中的全部请求；network detail 返回完整 body。
- evaluate/cdp 可返回接近 HTTP 64 MB 上限的任意对象。
- MCP 把成功 data pretty-print 为缩进 JSON。

### 状态风险

- `attachedTabId`、`lastUserTabId` 是 extension 全局状态。
- ref 表、ref 计数器、frame execution context cache 是 extension 全局状态。
- WebSocket 收到多个 `tool_call` 后直接异步执行，没有排序。
- daemon 的 session `Inject` 与 `Update` 分别加锁，但一次调用的“读目标—执行—写状态”不是完整事务。
- `find_tab(active:true)` 借用 tab 后不更新 daemon 的 `LastTabID`；session 原有 tab 时，后续调用会重新回到旧 tab。
- stale `_tabId` 按当前协议静默回退，可能落到另一个 session 的 attached tab 或用户正在查看的 active tab。

### 测试缺口

extension 当前只有 WebSocket 连接状态测试，没有覆盖 snapshot、AX YAML、ref 生命周期、多 tab、borrowed tab、stale target 或并发调用。

## 目标

1. 任意工具调用都能明确回答：目标 tab 是哪个、属于哪个 document epoch、引用来自哪次文档生命周期。
2. 不允许因为 stale target、并行调用或其他 session 的 snapshot 而操作用户无关页面。
3. CSI 主技能以**可用性为先**：工具索引完整、默认工作流明确，长尾说明按需加载；token 消耗在这个前提下观测与优化，不设硬上限。
4. 普通任务默认只返回完成下一步所需的信息；大结果必须分页、语义裁剪或落盘。
5. 同名按钮、表格行操作和多个 dialog 中的控件必须带足够的最小上下文，Agent 不需要靠猜。
6. 建立可重复的 Agent eval，用任务总 token 和首次选对目标率评价改造，而不是只看单个响应字符数。

## 非目标

- 不改变安全边界：daemon 继续只绑定 `127.0.0.1`，v1 仍无鉴权。
- 不在本设计中处理跨域 iframe 穿透、原生对话框或下载能力。
- 不立即把所有工具折叠为一个 `command(action,args)`；这会削弱 schema 校验与工具选择准确率。
- 不立即合并 `click` 与 `mouse_click`。工具面精简需要独立 eval 和兼容周期。
- 不直接降低 compact snapshot 的 24000 默认字符上限。先增加确定性筛选与上下文输出，再根据 eval 决定是否调整默认值。
- 不把 MCP 当作必然省 token 的方案；MCP schema 也有上下文成本，必须 A/B 验证。

## 核心不变量

后续实现必须保持以下不变量：

1. 每次 CDP 命令显式携带目标 tabId，不从全局“当前 tab”读取。
2. 每个 ref 只在一个 `tabId + documentEpoch` 中有效。
3. 同一 tab 的工具调用严格串行；不同 tab 在显式 TargetContext 与 cache 分区完成后允许并行。不经过「所有 tab 全局串行」过渡态，见 [目标隔离与并发模型](./2026-08-31-target-isolation-concurrency-design.md)。
4. borrowed tab 可以是当前操作目标，但永远不是 session owned tab。
5. `close_session` 只关闭 owned tab；不得关闭 borrowed tab。
6. stale target 不自动重放原动作。daemon 可以清理状态，但非幂等操作必须由 Agent 决定是否重试。
7. 任何协议变化先修改 `docs/protocol.md`，再同步 daemon、extension、MCP schema 和技能文档。

---

# 阶段 A：立即止血——全局串行执行

> **取消，不实施。** 在 `WsClient` 上加全局工具队列会把不同 tab、不同 session 也串行化，是过度约束的止血，不是正确的并发模型。终态是阶段 B.5（同 tab 串行、异 tab 并行、跨 session 同 tab 按 tab 串行、daemon 同 session 整段 `Execute` 串行），直接落地，不经过本阶段。可实施规格见 [2026-08-31-target-isolation-concurrency-design.md](./2026-08-31-target-isolation-concurrency-design.md)。下文 A.1–A.3 仅保留为被否决方案的记录，不要按它写 PR。

## A.1 目的

在完成 target/ref 状态重构前，先消除最直接的 CDP target 竞态。

## A.2 设计

`WsClient` 增加单一 promise queue。每个 `tool_call` 进入队列，前一个调用发送 `tool_result` 后才执行下一个。

队列要求：

- 成功和失败都必须释放队列。
- 一个调用超时或抛错不能阻塞后续调用。
- ping/pong 和连接管理不进入工具队列。
- socket 重连后不重放已经开始但未返回的调用，由 daemon 超时处理。

本阶段不开放不同 tab 并行。虽然吞吐下降，但浏览器 Agent 的主要模式本来就是观察—行动—再观察；准确性优先于并发吞吐。

## A.3 测试

- 同时发送两个会改变 `attachedTabId` 的工具，验证执行区间不重叠。
- 第一个调用抛错后，第二个调用仍执行。
- ping 在长工具调用期间仍能收到 pong。

本阶段不改公开协议，可以作为独立补丁发布。

---

# 阶段 B：目标状态与 ref 隔离

## B.1 daemon session 状态

现有 `TabIDs + LastTabID` 改为概念上的：

```text
Session {
  ownedTabIds: []tabId
  currentTarget: {
    tabId: tabId
    ownership: "owned" | "borrowed"
  } | null
  groupTitle: string
  revision: uint64
}
```

语义：

- `navigate` 只复用 owned tab；当前目标为 borrowed 时必须新建 owned tab，不得 `Page.navigate` 用户 tab。新建或复用后目标为 `owned`。
- `find_tab(active:false)` 命中 owned tab 后，目标为 `owned`。
- `find_tab(active:true)` 命中用户 active tab 后：若该 tab 已在 `ownedTabIds` 中则为 `owned`；否则为 `borrowed`（不加入 `ownedTabIds`）。owned 列表只来自 `ownedTabIds`/`_tabIds`，不得回退到 current / `_tabId`。
- `list_tabs.tabs` 只返回 owned tab。currentTarget 为 borrowed 时，响应增加独立字段
  `currentTarget:{tabId,borrowed:true,url,title}`，不能把它混入 `tabs`。
- `close_tab` 遇到 borrowed target 时返回 `closed:false, reason:"borrowed target is not owned by this session"`。
- `close_session` 只关闭 `ownedTabIds`，之后清空 currentTarget；即使 currentTarget 是 borrowed，也只清状态、不关用户 tab。

daemon 必须按 session 串行化完整调用生命周期。最低要求是同一 session 的请求按接收顺序执行；不同 session 是否并行由 extension 的 target 隔离能力决定。

## B.2 extension TargetContext

extension 不再用全局 `attachedTabId` 表示命令目标。每个工具执行前由 dispatcher 构造：

```text
TargetContext {
  tabId: number
  documentEpoch: number
}
```

所有 CDP helper 改为显式接口：

```text
ensureAttached(tabId)
sendCommand(tabId, method, params)
resolveObjectId(target, selector)
resolveFrame(target, frame)
```

`attachedTabIds` 可以继续作为“已经 attach 的集合”，但不能再隐式决定命令发往哪里。

## B.3 document epoch

每个 tab 维护单调递增的 `documentEpoch`。以下事件使 epoch 增加并仅清理该 tab 的 refs/frame cache：

- 主文档 committed navigation。
- tab reload 导致新主文档。
- debugger detach 后重新 attach，无法确认原 document 生命周期。
- tab close 时直接删除整个 TargetState。

iframe 子 frame 导航只失效该 frame 的 context/ref；实现第一版可以保守地提升整个 tab 的 epoch，但不能清理其他 tab。

## B.4 ref store

ref store 改为：

```text
Map<tabId, {
  documentEpoch,
  nextRef,
  refs: Map<ref, {
    backendDOMNodeId,
    frameId,
    role,
    name,
    documentEpoch
  }>
}>
```

消费 `@eN` 时必须验证：

1. ref 属于当前 tab。
2. ref 的 documentEpoch 等于当前 epoch。
3. `DOM.resolveNode` 成功。
4. 对 `click`、`mouse_click`、`fill`、`upload` 等会改变页面或用户数据的 selector 动作，重新读取当前 role 与可访问名称。role 或 trim 后的 name 与 ref 中保存值不一致时返回 `stale_ref`，要求重新 snapshot，不继续执行动作。

错误信息必须区分：

- `unknown_ref`：该 target 从未生成此 ref。
- `stale_ref`：ref 来自旧 document epoch 或节点已替换。

`@eN` 可以在不同 tab 的 ref store 中重复编号，因此不定义 `wrong_target_ref`。工具始终只查当前 TargetContext 的 store；当前 target 中没有该编号就是 `unknown_ref`，epoch 不一致就是 `stale_ref`。

## B.5 并发模型

完成显式 target 与所有 cache 分区后：

- 同一个 tab：严格串行。
- 不同 tab：允许并行。
- 两个 session 同时 borrow 同一用户 tab：按 tab 串行。
- daemon 同一 session：仍按 session 串行，避免响应完成顺序反转 currentTarget。

**不要先做阶段 A 的全局队列再「细化」成本节。** 可实施规格（队列占用、锁范围、tab 解析、stale 不回退、最小 currentTarget、测试矩阵与 PR 切分）见 [2026-08-31-target-isolation-concurrency-design.md](./2026-08-31-target-isolation-concurrency-design.md)。

---

# 阶段 C：stale target 错误契约

## C.1 为什么不能继续静默 fallback

当 daemon 注入了非零 `_tabId`，说明调用方相信 session 有明确目标。这个 tab 已关闭时，静默回退到 last-user 或 active tab 会把“恢复可用性”变成“可能操作错误页面”。

只有 session 从未建立过 target 时，首次 `navigate` 或显式 `find_tab(active:true)` 才能使用当前用户 tab 相关的选择逻辑。普通单 tab 工具没有明确 target 时应报错。

## C.2 兼容错误结构

保留现有 `error` 字符串，并增加可选字段：

```json
{
  "success": false,
  "error": "session target tab 123 is no longer available",
  "code": "stale_target",
  "details": {
    "tabId": 123,
    "session": "my-task",
    "nextTabId": 122
  }
}
```

WS `tool_result.payload` 同样允许 `code` 与 `details`。旧客户端继续读取 `error`；新客户端按 `code` 做恢复。

## C.3 daemon 恢复规则

extension 返回 `stale_target` 后，daemon：

1. 从 `ownedTabIds` 移除失效 tab。
2. 如果 currentTarget 指向它，选择最后一个仍存活的 owned tab 作为新 currentTarget；没有则置空。
3. 返回本次错误，不自动重放原工具。
4. 在 details 中提供 `nextTabId`，让 Agent 知道下一次 snapshot 可恢复到哪个 session tab。

Agent 收到错误后：

- 有 `nextTabId`：先 snapshot 确认页面，再决定是否重试。
- 无 `nextTabId`：重新 navigate，或在用户明确要求操作现有页面时调用 `find_tab(active:true)`。

---

# 阶段 D：snapshot 识别精度与结果预算

## D.1 contextual interactive

现有 interactive 只保留带 ref 的节点并完全扁平化。新格式保留最小可辨识祖先，候选祖先角色限定为：

```text
dialog form row listitem article region navigation main
```

每个交互节点最多保留两个最近的有名称祖先。共享同一祖先的节点继续用 YAML 分组，避免重复整条路径：

```yaml
- dialog "Delete project"
  - button "Cancel" [ref=@e8]
  - button "Delete" [ref=@e9]
- row "Alice"
  - button "Edit" [ref=@e12]
```

没有有名称祖先时维持当前单行输出。

## D.2 确定性 match

snapshot 增加可选 `match`，现有 `selector` 继续承担 scope 作用：

```json
{
  "mode": "interactive",
  "selector": "@e12",
  "match": {
    "role": "button",
    "name": "Delete",
    "exact": true
  }
}
```

规则：

- `match.name` 必填；`role` 可选。
- `exact` 默认 `true`。需要子串匹配必须显式传 `false`。
- 大小写按 Unicode 简单 case-fold 后比较。
- match 只过滤输出，不自动点击，不自动选择第一个结果。
- 返回增加 `matches` 数量。
- 多命中全部返回，并附最小祖先上下文。
- 零命中返回成功空结果及 `matches:0`，不是工具错误。

不提供自由文本语义搜索；确定性 role/name/scope 足够覆盖同名控件和大表格定位。

## D.3 snapshot 上限与 full 语义

**语义原则：`full` 承诺的是「数据完整性」——节点、属性、层级不裁剪——而不是「无限字节内联」。** 数据完整性与投递通道是两件事：完整性永远拿得到，但超过模型上下文预算的部分改走 artifact 文件（D.4），与 screenshot/PDF 的「daemon 落盘、返回路径」（协议 §5）同一哲学。无限内联在大页面上是假命题：WS 有 64MB 传输上限，模型上下文也装不下数 MB 的 AX 树。真返回了只会被宿主静默截断——Agent 拿残缺数据当完整数据继续推理，错得无声无息，比显式引导更糟。

- compact/interactive 暂时保持默认 24000 字符、范围 1000–80000。
- match 后仍应用 `max_chars`。
- full 树 ≤ 80000 字符：原样内联返回，与现状一致。
- full 树 > 80000 字符：**自动转 artifact**（D.4），完整 JSON 由 daemon 落盘，返回 preview、path、sourceChars，并附引导语：多数任务用 `selector`/`match` 缩小范围更省。不得截断成非法 JSON，也**不**返回 `result_too_large`——「调用方要完整树」是可满足的请求，不是错误用法。与 evaluate/cdp（D.5）的超限行为对齐，Agent 只需学一套规则。
- 转 artifact 不影响 ref 分配：refs 在树构建时已写入该 tab 的 store（含 full 模式的 iframe 节点），与结果是否内联无关。
- `result_too_large` 只保留给真正无法投递的场景（WS 传输超限、写盘失败等）。
- 返回同时提供 `source_chars` 与 `returned_chars`，避免当前 `chars` 无法表示截断前规模。

命名说明：`full` 同时承担「完整树」和「唯一 JSON 结构化输出」两个含义，不少调用方选它是为了可解析而非真要整棵树。本期不改名；match（D.2）落地后，「为了定位元素而拍全树」的需求由确定性 match 覆盖，full 回归纯粹的完整性逃生口。

## D.4 通用 artifact 信封

extension 到 daemon 的内部结果允许携带 artifact：

```json
{
  "artifact": {
    "encoding": "utf8",
    "mimeType": "application/json",
    "suggestedName": "csi-evaluate-result.json",
    "data": "..."
  },
  "preview": "...",
  "sourceChars": 240000
}
```

daemon 落盘后，客户端只收到：

```json
{
  "truncated": true,
  "preview": "...",
  "path": "/tmp/csi-evaluate-result-....json",
  "sizeBytes": 320000,
  "mimeType": "application/json"
}
```

artifact 只是内部 WS/daemon 契约；HTTP/MCP 客户端不接收原始 `data`。调用方显式要求输出到项目目录时继续沿用现有 path 语义。

## D.5 各工具预算

### network list

- 新增 `limit`，默认 50，最大 500。
- 新增 `cursor`，返回 `nextCursor`。
- 每个 tab 的捕获表改成最多 2000 条的 ring buffer。
- 超出时丢最旧记录，返回累计 `droppedCount`。

### network detail

- 新增 `body_mode=preview|file|full`，默认 `preview`。
- preview 默认最多 12000 字符，并返回 `sourceChars`、`truncated`。
- file 通过 artifact 落盘，只向 Agent返回 preview + path。
- full 仅显式请求，仍受 80000 字符上限；更大结果要求 file。

### evaluate / cdp

- 新增 `max_chars`，默认 12000，最大 80000。
- 序列化后未超限则正常返回。
- 超限默认返回 preview + artifact path，不向模型内联完整结果。
- 不允许从 JSON 中间直接裁切后伪装成合法对象。

### MCP

- 成功 data 使用紧凑 JSON，不做 `json.Indent`。
- screenshot/PDF/artifact 的查看提示保持一行，不重复 path。
- 暂不删除工具 data 内已经进入协议的 `success:true`；收益过低，留待独立兼容清理。

---

# 阶段 E：技能渐进加载

## E.1 主技能：能力优先，token 只观测

主技能的约束是「Agent 能用好」：工具面完整可见、关键工作流与坑位齐备。**token 消耗在这个前提下观测，不设硬上限**——原 1,200 tokens 门槛取消；先把体积卡瘦会牺牲可用性，本末倒置（「能用好」约束下的 token 消耗才有评价意义）。主文件保留：

1. 准确触发边界。
2. **21 个工具的目标分组索引**（工具名 + 一句话用途 + 对应 reference），兼作按需加载的路由表——工具索引不能缺，否则 Agent 看不到工具面，只剩工作流叙事。
3. 默认工作流：`navigate → snapshot → @e → action → wait`，含「动作后必须 wait、不 sleep 不轮询」。
4. 一个 task 复用一个 session。
5. 优先 `@e`，evaluate/cdp 是逃生口。
6. daemon 不可达时的单句恢复入口。

## E.2 reference 布局

```text
skills/csi/
├── SKILL.md
└── references/
    ├── http-transport.md
    ├── tabs-and-sessions.md
    ├── interaction.md
    ├── frames.md
    ├── large-results.md
    └── operations.md
```

- `http-transport.md`：curl、Windows 文件请求体、HTTP envelope。
- `tabs-and-sessions.md`：newTab、find_tab、borrowed、关闭规则。
- `interaction.md`：snapshot/ref、fill、wait、键盘、trusted click。
- `frames.md`：同源/跨域 iframe 与 list_frames。
- `large-results.md`：screenshot、PDF、network、evaluate/cdp artifact。
- `operations.md`：安装、启动、版本错位、日志和恢复。

工具完整参数表不再同时复制到主技能和多个平台说明。HTTP agent 从 `http-transport.md` 读取；原生 MCP agent 以 tool schema 为准。

## E.3 触发边界

frontmatter 正向触发保留：

- 操作用户真实 Chrome。
- 需要用户现有登录态。
- 导航、点击、填写、读取或截图真实网页。

增加排除边界：

- 仅讨论浏览器实现、前端代码、URL 格式或截图概念，不需要打开页面时不触发。
- 用户要求 headless、隔离 profile 或纯 HTTP 抓取时不默认选择 CSI。
- 普通代码审查中出现 browser/webpage 字样不触发。

## E.4 自动校验

CI 增加：

- 用固定 tokenizer 统计并**报告**主技能 token（观测项，不 fail——门槛取消，见 E.1）。
- 检查 SKILL.md 中的 reference 链接都存在。
- 检查协议工具清单、daemon validTools、MCP toolDefs、extension registry 一致。
- 如果工具 schema 改动而协议与技能路由未改，测试失败。

---

# 阶段 F：Codex MCP A/B

仓库已有 `csi mcp`，Codex plugin 也支持声明 MCP server。先建立实验，不直接将 MCP token 优势写成事实。

## F.1 两个实验组

### HTTP 组

- 精简 SKILL.md。
- 按需加载 `http-transport.md`。
- Agent 通过 shell/curl 调用 `/command`。

### MCP 组

- 精简 SKILL.md。
- Codex plugin 注册 `csi mcp`。
- Agent 直接调用 21 个具名 MCP tools。

## F.2 评价指标

- 浏览器任务启动时上下文 token。
- 完成任务的总输入/输出 token。
- 首次选对工具率。
- 参数校验失败次数。
- shell quoting/Windows 编码失败次数。
- 平均工具调用轮数。

只有 MCP 组在准确率不下降且总 token 更低，才作为 Codex 默认 transport。若 MCP 主要提升准确率但略增 token，可以作为显式产品权衡记录，而不是宣传成纯降本。

---

# 测试与 Agent eval

## 单元与集成测试

最低回归矩阵：

1. tab A snapshot → tab B snapshot → tab A click，A 的 ref 不被 B 覆盖。
2. 同时向 tab A/tab B 发工具调用，命令不交叉 target。
3. 同一 tab 两个调用严格顺序执行。
4. session 已有 owned tab → borrow active tab → snapshot/click 仍在 borrowed tab。
5. borrowed target 下 close_tab/close_session 不关闭用户 tab。
6. owned tab 被用户关闭后，返回 stale_target，绝不操作无关 active tab。
7. 主文档导航只清理当前 tab 的 ref/frame cache。
8. ref 来自旧 documentEpoch 时返回 stale_ref。
9. contextual interactive 对两个同名按钮返回不同祖先上下文。
10. snapshot match 的 exact、substring、多命中、零命中行为稳定。
11. network ring buffer 达上限后 droppedCount 正确。
12. full snapshot/evaluate/cdp 超限时返回有效 preview/path，不返回破损 JSON。

## Agent eval 场景

固定至少以下任务：

- 文档站读取指定章节。
- 后台表格中编辑指定用户。
- 两个 dialog 中选择正确的同名确认按钮。
- 同时比较两个 tab 后回到第一个 tab 操作。
- session 已有页面时借用用户当前页面。
- 页面在 snapshot 后发生 SPA 重渲染，旧 ref 必须失败并引导重拍。
- 捕获大量 network 请求并找出指定 API body。
- evaluate 返回超大 JSON。

每个场景记录：

- 是否成功。
- 是否操作过错误 tab/元素。
- 首次目标命中率。
- snapshot 次数与重拍次数。
- 工具调用总轮数。
- 总 token、最大单次工具结果 token、p50/p95。
- stale_ref/stale_target 恢复轮数。

## 验收标准

1. 并发、borrowed 和 stale 四组关键回归中，wrong-tab 次数为 0。
2. 同名控件 eval 的首次目标命中率为 100%。
3. 主 SKILL.md 不读任何 reference 即可看到全部 21 个工具与默认工作流；token 数由 CI 观测记录，不设门槛（可用性是约束，token 是指标）。
4. 除显式 full/file 请求外，任何单次文本工具结果不得超过其声明的 max_chars。
5. 典型浏览器任务总 token 的 p50 至少下降 30%，p95 至少下降 50%。
6. 改造后任务成功率不得低于改造前基线。

---

# 实施顺序

严格按下面顺序推进，每阶段都可以独立验证：

1. 目标隔离与并发终态（**不是** extension 全局工具队列）：按 [2026-08-31-target-isolation-concurrency-design.md](./2026-08-31-target-isolation-concurrency-design.md) 的 PR Plan（协议 stale/borrowed → daemon session FIFO → 显式 tabId CDP → per-tab ref/frame → dispatcher per-tab 队列）。阶段 A 已取消。
2. 协议先行：session currentTarget、borrowed 语义、stale/error code（若未包含在第 1 步的协议 PR 中）。
3. daemon session 串行与 owned/currentTarget 状态实现（与第 1 步 daemon PR 对齐）。
4. extension 显式 TargetContext、per-tab document epoch、ref/frame cache 隔离（与第 1 步 extension PR 对齐）。
5. dispatcher per-tab 队列与 close_tab/close_session 获取规则（第 1 步最后一刀；**没有**「先全局队列再细化」）。
6. 协议先行：snapshot match/context 与各工具结果预算。
7. extension/daemon artifact、network 分页与 ring buffer、MCP 紧凑输出。
8. 技能渐进拆分与 token CI。
9. Codex MCP A/B；根据数据决定默认 transport。

不要把已取消的阶段 A 全局队列与阶段 B/D 的协议重构塞进同一个提交。状态正确性、结果预算和技能重写分别评审，回归定位更清楚。任何实现 PR 都不得夹带 `WsClient` 全局工具队列。

## 文件地图

预期涉及：

- `docs/protocol.md`：session target、错误结构、snapshot match、结果预算与 artifact 契约。
- `daemon/internal/session/`：owned/currentTarget、session 串行、stale 清理。
- `daemon/internal/tools/`：结构化错误与 artifact 后处理。
- `daemon/internal/mcp/`：schema 同步、紧凑输出、artifact path 提示。
- `extension/src/background/ws-client.ts`：保持 `void handleToolCall`；**不要**加全局工具队列。
- `extension/src/background/tab-queue.ts`（新）：per-tab promise 队列。详见 [目标隔离规格](./2026-08-31-target-isolation-concurrency-design.md)。
- `extension/src/background/debugger-session.ts`：显式 tabId CDP 调用。
- `extension/src/background/refs.ts`：per-tab/per-document ref store。
- `extension/src/background/frames.ts`：per-tab frame/cache 生命周期。
- `extension/src/background/registry.ts`：TargetContext 与 stale target。
- `extension/src/background/tools/snapshot.ts`、`ax-yaml.ts`：contextual interactive、match、full 上限。
- `extension/src/background/tools/network.ts`：分页、ring buffer、body mode。
- `extension/src/background/tools/evaluate.ts`、`cdp.ts`：结果预算与 artifact。
- `skills/csi/`：主技能缩减与 references 重排。
- `.codex-plugin/`：MCP 实验配置。

## 风险与回滚

- 不采用全局工具队列。异 tab / 异 session 并行的正确性由显式 TargetContext、per-tab 分区与 per-tab 队列保证；回滚时不要只撤分区而留下并行 dispatcher。
- session 状态变化可能影响现有 tab group 行为，必须保留 owned tabs 的对外语义。
- error 增加 code/details 必须保持旧 `error` 字符串，确保旧 HTTP 客户端继续工作。
- snapshot 输出变化影响模型行为，必须用固定 eval 对比，不能只做字符串测试。
- artifact 会把页面/network/evaluate 内容落到临时目录，沿用现有 screenshot/PDF 的本机信任边界和清理策略，并在协议隐私章节说明。
- MCP 自动注册涉及不同宿主和操作系统的启动路径；A/B 阶段不得影响已有 HTTP 路线。

## 刻意不做的替代方案

- 只在技能里提醒 Agent“不要并行”：无法约束宿主并行工具调用，也不能修复跨 tab ref 覆盖。
- 只给 ref 加更长随机编号：能减少碰撞感知，不能修复错误 target 与 document 生命周期。
- 把所有 snapshot 默认降到极小上限：token 会下降，但文章读取和结构理解准确率也会下降。
- 用自由文本语义 query 自动选第一个元素：把确定性错误变成不可解释的猜测。
- 所有大结果统一硬截字符串：会破坏 JSON，并让 Agent无法获取完整证据。
- 为省 schema token 把所有工具合并成一个 meta-tool：参数约束和工具选择准确率会退化。

## 审查重点

用户审查本文件时，优先确认：

1. borrowed tab 是否应该持续成为 currentTarget，直到显式切换。
2. stale target 是否接受“清理状态但不自动重放动作”的规则。
3. contextual interactive 的祖先角色与最多两层限制是否合适。
4. network 50/500/2000 与 evaluate/cdp 12000/80000 的预算是否符合实际使用。
5. full 超限从原方案的 `result_too_large` 报错改为**自动转 artifact**（与 evaluate/cdp 对齐，见 D.3），是否接受。
6. 主技能 1,200 tokens 和 p50/p95 降幅是否适合作为验收门槛。
7. Codex MCP 是否保持 A/B 实验，而不是直接设为默认。
