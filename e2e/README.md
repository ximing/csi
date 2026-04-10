# e2e 回归

用 csi 自己测 csi：真实 Chrome 里回放 21 个工具的主路径，靶子是本目录自带的
静态 testbed（`testbed/`，营销站 `site/` 是假输入、当不了靶子）。

## 跑法

```bash
node e2e/testbed/serve.mjs &   # 8931 = 主源，8932 = 跨源（同目录双端口 = 双源）
node e2e/run.mjs               # 全部 suite；node e2e/run.mjs iframe 跑单个
```

前置：csi daemon 在跑、扩展已连接（`curl -s http://127.0.0.1:10088/status` 里
`extension_connected: true`）。无需任何 npm 依赖，Node ≥ 18 即可。

## 布局

- `cases/*.md` — 人用例（每个工具面一个文件，每步带【预期】）
- `suites/*.mjs` — 同名固化脚本，禁 `@e` 硬编码，只用稳定 selector
- `lib/` — daemon HTTP 封装 + 环境助手（`openPage` 会清场、bringToFront、开焦点仿真）
- `testbed/` — 静态靶场页（表单/悬停/长滚动/fetch/上传/延迟元素/同域+跨域 iframe）
- `artifacts/` — 证据产物（gitignore）

## 覆盖

| suite | 工具 |
|---|---|
| smoke | 链路自检（navigate + evaluate） |
| tabs | navigate / list_tabs / find_tab / close_tab / close_session |
| interact | snapshot / click / fill / key_type / send_keys / mouse_click / hover / scroll |
| read-wait | evaluate / cdp / wait |
| capture | screenshot（视口 + fullPage）/ save_as_pdf |
| network-upload | network / upload |
| iframe | list_frames / snapshot·click·fill·evaluate 的 frame 参数 / 跨域报错 |

## 已踩过的坑（改 suite 前先看）

- **窗口不在 OS 前台时 trusted 键事件会被丢**：`visibilityState=hidden` 的 tab 里
  `send_keys` 静默无效、`mouse_click` 不移动焦点。`lib/env.mjs` 的 `openPage`
  已对当前 tab 开 `Emulation.setFocusEmulationEnabled`，与 OS 窗口状态解耦——
  新套件务必走 `openPage` 进场。
- **合成 click 不改 `<select>` 值**：点 `<option>` 无效，用 evaluate 设
  `value` + dispatch `change`。
- **click 工具不移动焦点**（DOM 级 `el.click()`）：`key_type` 前先 evaluate
  `focus()`，或用 `mouse_click`。
- **find_tab 按 hostname 匹配**，路径被忽略：同 host 两个 tab 无法区分，
  所以 tabs 用例用 127.0.0.1 / localhost 双 host。
