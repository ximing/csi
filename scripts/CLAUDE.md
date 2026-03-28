# scripts 目录说明

## 这个目录负责什么

安装器：`install.sh`（macOS/Linux）与 `install.ps1`（Windows 5.1+）。从 GitHub Releases 下载预编译 daemon、构建好的扩展和两份技能，无需本地 Go/Node。

`package-extension.sh` 是纯开发侧的 Chrome Web Store 上架打包脚本（构建 dist → 打 zip 到 `release/`），不面向最终用户，无双端 parity 要求。

## 放置约束

- **双端 parity 是硬约束**：`install.sh` 与 `install.ps1` 必须支持同一组旗标（`--no-start`/`-NoStart`、`--no-skill`/`-NoSkill`、`--agents`/`-Agents`、`-y`/`-Yes`）与同一组环境变量（`CSI_VERSION`、`CSI_AGENTS`）。加功能时两端同时改。
- 安装布局：`~/.csi/bin`（daemon）、`~/.csi/extension`（扩展）。技能按 `--agents` 目标分发，默认只装 claude：`~/.claude/skills/csi` + `csi-e2e`；可选 `~/.codex/skills`、`~/.cursor/skills`、`~/.agents/skills`（跨工具标准目录）、`~/.config/opencode/skills`。Kimi / Grok / Pi 走各自的插件安装命令，安装器不覆盖。改布局要同步改 README、技能文档里所有引用这些路径的地方。
- 安装结束默认启动 daemon，且 `csi start` 幂等——不要破坏这个行为。

## 开发偏好

- shell 端用 `set -euo pipefail`；PowerShell 端兼容 5.1，不要用 7+ 专属语法。
