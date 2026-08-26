# CSI

[English](README.md) | **简体中文**

**CSI** — Ctrl+Shift+I，每个程序员都按过的 DevTools 快捷键；也是 Crime Scene Investigation——AI 勘查浏览器案发现场。

**给 AI agent 用的浏览器自动化(browser automation)工具。** 让 AI(Claude Code 及其它 agent)控制你**真实的 Chrome 浏览器**——导航、点击、输入、读取页面、截图、保存 PDF——使用你实际的登录态。不需要带自动化标记的浏览器,也不需要单独的 profile:agent 直接驱动你正在用的那台 Chrome。底层是本地 Go daemon 加 Chrome 扩展(MV3),通过 **Chrome DevTools Protocol (CDP)** 执行——相比 MCP 浏览器控制或 Playwright/Selenium,它是需要**真实登录态**(而非全新无头 profile)时的轻量替代。

## 架构

```
AI 客户端 (Claude Code skill)
        │  HTTP POST /command  (JSON)
        ▼
┌─────────────────────────────┐
│  daemon (Go)                │  127.0.0.1:10088
│  HTTP server + WS server    │  仅回环，无鉴权 (v1)
└─────────────────────────────┘
        ▲  WebSocket /ws  (扩展作为 WS 客户端，自动重连)
        │
┌─────────────────────────────┐
│  Chrome 扩展 (MV3 SW)        │  跑在你真实的 Chrome 里
│  通过 CDP 执行工具           │  对你的标签页调用 debugger API
└─────────────────────────────┘
```

- daemon 既是 AI 客户端的 HTTP server，也是扩展的 WebSocket server。扩展主动连向 daemon；同一时刻只保留一个扩展连接。
- 每条命令都带一个 `session` 名；每个 session 的标签页会被收进一个 Chrome 标签组（`agent:<session>`），一眼就能看出 agent 在干什么。
- 截图和 PDF 由 daemon 写到磁盘，返回文件路径。

完整的线上协议契约见 [docs/protocol.md](docs/protocol.md)。

## 快速开始

前置条件：Chrome。扩展从 [Chrome 应用商店](https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol) 或 [GitHub Releases](https://github.com/ximing/csi/releases) 的预编译 zip 安装。daemon 始终是 Releases 上的预编译二进制——不需要 Go/Node，也不需要从源码构建。

### 方式 A — Chrome 应用商店（推荐）

**1. 安装扩展**：打开 [Chrome 应用商店里的 CSI](https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol)。

**2. 安装 daemon**（以及 Claude Code 技能）。`--no-extension` 会跳过解压版 zip——商店里已经有扩展了：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash -s -- --no-extension
```

```powershell
# Windows (PowerShell 5.1+)
$env:CSI_NO_EXTENSION='1'; irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
```

**3. 打开扩展弹窗**，确认显示"已连接"。

**4. 检查一切就绪**（安装器已经启动了 daemon；`csi start` 是幂等的——随时可安全运行）：

```bash
curl -s http://127.0.0.1:10088/status
# → {"running":true,"extension_connected":true,...}
```

### 方式 B — GitHub Release（手动加载）

无法使用 Chrome 应用商店时用这个。安装器会下载预编译 daemon、`csi-extension.zip` 和技能。

**1. 安装** —— daemon → `~/.csi/bin`，扩展 → `~/.csi/extension`，Claude Code 技能 → `~/.claude/skills/csi` + `~/.claude/skills/csi-e2e`；安装末尾会启动 daemon：

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/ximing/csi/master/scripts/install.sh | bash
```

```powershell
# Windows (PowerShell 5.1+)
irm https://raw.githubusercontent.com/ximing/csi/master/scripts/install.ps1 | iex
```

**2. 在 Chrome 中加载扩展**（手动步骤）：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `~/.csi/extension`。打开扩展弹窗，确认显示"已连接"。

**3. 检查状态** —— 与方式 A 同一个 `curl`。

两个安装器接受相同的旗标：`--no-extension` / `-NoExtension`（跳过解压版 zip；也可用 `CSI_NO_EXTENSION=1`），`--no-start` / `-NoStart`（不启动 daemon），`--no-autostart` / `-NoAutostart`（不注册登录自启；也可用 `CSI_NO_AUTOSTART=1`；再跑一次安装器会把曾经 `csi autostart off` 过的自启重新打开），`--no-skill` / `-NoSkill`（完全跳过技能），`--agents codex,cursor` / `-Agents codex,cursor`（选择技能安装目标，见[编程 Agent Skills](#编程-agent-skills)），`-y` / `-Yes`（覆盖已存在的技能安装前不再询问）。用 `CSI_VERSION=v0.1.0` 固定某个 release。

**驱动浏览器：**

```bash
curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true,"group_title":"Demo"},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"snapshot","args":{},"session":"demo"}'

curl -s -X POST http://127.0.0.1:10088/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","args":{},"session":"demo"}'
```

安装器还会把两个 Claude Code 技能复制到 `~/.claude/skills/`：`csi`（浏览器控制——你让 Claude Code 与网站交互时会自动启用）和 `csi-e2e`（e2e 测试套件——见下文）。

## MCP server

`csi mcp` 跑一个 stdio MCP server，暴露全部 21 个浏览器工具。它是一个薄代理：每次工具调用都转发给本地 daemon 的 `POST /command`（同一个 `CSI_PORT`，默认 10088），所以 daemon 必须在运行（`csi start`）。

在 Claude Code 中挂载：

```bash
claude mcp add csi -- ~/.csi/bin/csi mcp
```

每个工具还接受一个可选的顶层 `session` 参数（默认 `"default"`），映射到 daemon 的 session 字段。`screenshot`/`save_as_pdf` 返回文件路径——用 Read 工具查看。

## E2E 测试技能

安装器还会把第二个技能 `csi-e2e` 放进 `~/.claude/skills/`。它把自然语言描述的浏览器场景变成可重放的 e2e 回归套件——由同一个 daemon 驱动，不需要测试框架，除了 Node ≥ 18 没有别的依赖：

1. **描述** —— 模型在你的项目里写 `e2e/cases/<name>.md`：一个声明被测 URL 和如何启动应用的头部，然后是带机器可校验【预期】的编号步骤。
2. **验证** —— 它通过 daemon 在你真实的 Chrome 里现场执行用例，反复迭代直到每个预期都成立。
3. **固化** —— 通过的部分被翻译成 `e2e/suites/<name>.mjs`（通过 HTTP 与 daemon 通信的纯 Node 脚本）。
4. **重放** —— `node e2e/run.mjs [suite...]`，不涉及模型。

在任何 web 项目里让 Claude Code"给 X 写个 e2e 测试"，技能就会启动。完整工作流见 [skills/csi-e2e/SKILL.md](skills/csi-e2e/SKILL.md)。

## 编程 Agent Skills

CSI 在 [`skills/`](./skills) 下内置 [Agent Skills](https://code.claude.com/docs/en/claude-code/skills)，教编程 Agent 驱动你真实的 Chrome：

| Skill | 用途 |
| --- | --- |
| [`csi`](./skills/csi) | 通过本地 daemon 驱动用户真实 Chrome —— 导航、点击、输入、截图、存 PDF，带真实登录态。 |
| [`csi-e2e`](./skills/csi-e2e) | 把自然语言浏览器场景变成可重放的 e2e 回归套件（描述 → 验证 → 固化 → 重放）。 |

技能本体是纯 `SKILL.md` 文档（外加 `references/` 与模板），零运行时依赖，同一份文件适用于各编程工具。安装方式因工具而异 —— 多个工具同时使用时，需要分别为每个工具安装。

### Claude Code

```bash
/plugin marketplace add ximing/csi
/plugin install csi@csi
```

或手动安装：`cp -r skills/csi skills/csi-e2e ~/.claude/skills/`

### Codex App / Codex CLI

本仓库自身就是一个 Codex 插件市场（见 [`.agents/plugins/marketplace.json`](.agents/plugins/marketplace.json)），无需官方上架：

```bash
codex plugin marketplace add ximing/csi
codex plugin add csi@csi
```

### Cursor

插件清单在 [`.cursor-plugin/plugin.json`](.cursor-plugin/plugin.json)。在 Cursor Agent 对话框中执行 `/add-plugin csi`，或在插件市场搜索 `csi`。也可以手动把技能目录拷进项目的 `.cursor/skills/`。

### Grok Build CLI

从 xAI 官方插件市场安装（收录 PR 已提交、审核中：[xai-org/plugin-marketplace#266](https://github.com/xai-org/plugin-marketplace/pull/266)）：

```bash
grok plugin install csi@xai-official --trust
```

### Kimi Code

```text
/plugins install https://github.com/ximing/csi
```

安装后新开会话（`/new`）使插件生效。

### OpenCode

在 `opencode.json`（全局或项目级）里加插件；它会通过 OpenCode 插件系统注册 `skills/`：

```json
{
  "plugin": ["csi@git+https://github.com/ximing/csi.git"]
}
```

### Pi

```bash
pi install git:github.com/ximing/csi
```

[`package.json`](package.json) 里的包清单为 Pi 的原生技能发现声明了 `skills/` 目录。

> 说明：[快速开始](#快速开始)里的 shell/PowerShell 安装器也可以直接把技能装进其他工具的目录 —— 加 `--agents codex,cursor,agents,opencode`（或 `all`；PowerShell 端 `-Agents ...`），默认只装 `claude`。目标：`~/.codex/skills/`（Codex）、`~/.cursor/skills/`（Cursor）、`~/.agents/skills/`（跨工具标准目录，Cursor 和 OpenCode 都读）、`~/.config/opencode/skills/`（OpenCode）。Kimi、Grok Build、Pi 用上面各自的插件安装命令，安装器不覆盖。无论哪种方式，daemon 仍然必需；Chrome 扩展从 [Chrome 应用商店](https://chromewebstore.google.com/detail/csi/mlnlngdpkodcnblmdgdnlaidijaffeol) 或 Release zip 安装。技能只是教 Agent 怎么与 daemon 对话。

## 工具

21 个工具：`navigate`、`find_tab`、`snapshot`（默认 compact YAML 无障碍树，带 `@e` 引用）、`click`、`fill`（输入框 + contenteditable）、`evaluate`、`network`、`mouse_click`（可信的坐标级点击）、`wait`、`scroll`、`hover`、`key_type`、`send_keys`、`cdp`（原始透传）、`screenshot`、`save_as_pdf`、`upload`、`list_tabs`、`close_tab`、`close_session`、`list_frames`。精确契约见 [docs/protocol.md](docs/protocol.md) §4。

## 目录结构

```
csi/
├── docs/protocol.md        # 线上协议的唯一事实来源
├── daemon/                 # Go daemon（HTTP + WS server，session 状态）
│   └── cmd/csi/
├── extension/              # Chrome MV3 扩展（TypeScript，service worker）
│   └── dist/               # 构建产物——在 chrome://extensions 里加载这个
├── skills/csi/             # 编程 Agent 技能：浏览器控制（SKILL.md + references/）
├── skills/csi-e2e/         # 编程 Agent 技能：描述→验证→固化→重放 e2e 套件
├── .claude-plugin/         # 各工具插件清单：Claude Code、Codex、Cursor、Kimi、OpenCode、Pi
│   └── ...                 #（.claude-plugin/ .codex-plugin/ .agents/ .cursor-plugin/ .kimi-plugin/ .opencode/）
├── scripts/                # 安装器：install.sh（macOS/Linux）、install.ps1（Windows）
└── .github/workflows/      # release.yml——打 v* tag → 交叉编译 daemon + 扩展 → GitHub Release
```

## 开发

这一节给贡献者。**使用** CSI 请从 Chrome 应用商店或 GitHub Release zip 安装扩展——不要从源码构建，除非你在改代码。

```bash
# daemon
cd daemon
go test ./...
go build -o ~/.csi/bin/csi ./cmd/csi

# 扩展
cd extension
npm install
npm run build        # 产出 extension/dist——在 chrome://extensions 里 reload

# 发版（推一个 tag → workflow 交叉编译一切并起草 Release）
git tag v0.1.0 && git push origin v0.1.0
```

协议变更：先改 `docs/protocol.md`，再改两侧实现。协议文件就是契约；实现必须服从它。

端口：默认 `10088`，用 `CSI_PORT` 环境变量覆盖（在扩展弹窗里设置相同端口）。点扩展图标 → Settings 打开设置页：查看 daemon 状态、改端口 / 日志保留天数 / 工具超时，以及调整自动重连间隔。

## 安全说明

- daemon 只绑 `127.0.0.1`；v1 没有鉴权——回环就是隔离边界（本机 vs 网络，不是进程沙箱）。任何能连上这个端口的进程都能驱动你的浏览器。
- `evaluate` 和 `cdp` 是页面内的任意代码执行通道。这是设计能力，不是 bug——据此对待技能提示。
- `screenshot` / `save_as_pdf` 按调用方给的 `path` 原样落盘（父目录自建、覆盖写）。没有路径沙箱：能 `POST /command` 的本地进程已经在 loopback 信任域里，自己也能写这些文件。`path` 请用绝对路径——相对路径相对的是 daemon 的 cwd，不是调用方的。详见 [docs/protocol.md](docs/protocol.md) §7。
- `upload` 把调用方给的 `files` 路径原样交给 Chrome `DOM.setFileInputFiles`。没有 Downloads（或其它）路径沙箱：产品就是把用户指定的本地文件——包括项目文件——塞进网页 file input。随机网页不能 `POST /command`；若 AI 被诱导去上传私钥，那是 AI 客户端/用户的信任问题。详见 [docs/protocol.md](docs/protocol.md) §7。

## 许可

[PolyForm Noncommercial 1.0.0](LICENSE)——任何非商用目的都被允许（个人使用、研究、教育、慈善、政府机构……）；商用未获许可。需要商用授权请开 issue。

## 路线图

- **0.4 Agent 可靠性** — compact YAML snapshot、真正的 `wait`、`scroll` / `hover`、整页截图、版本握手（商店扩展过旧时说「请升级」而不是 `unknown tool`）。规格：[docs/superpowers/specs/2026-03-30-agent-reliability-design.md](docs/superpowers/specs/2026-03-30-agent-reliability-design.md)。
- **0.5 开机自启** — 已做：`csi autostart on|off` + 安装器默认打开，重启电脑后 daemon 还在。
- **0.6 难页面** — iframe（ref 自带 `frameId`）、JS 对话框、下载（要过 CWS 权限审核）。
- **DirectCDPBackend**：连接 [obscura](https://github.com/h4ckf0r0day/obscura)——一个带内置 CDP server 的 Rust 无头浏览器。daemon 会直接和它的 CDP WebSocket 对话，不需要 Chrome 扩展，在当前真实 Chrome 模式之外提供完全无头的自动化。
