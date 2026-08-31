# Homebrew 安装与 AGPL 许可证设计

日期：2026-08-31
状态：已确认
分支 / worktree：`homebrew-daemon` / `.worktrees/homebrew-daemon`

## 背景

CSI daemon 今天靠 `scripts/install.sh` / `install.ps1` 从 GitHub Release 拉预编译包，装到 `~/.csi/bin`，默认 `csi autostart on` + `csi start`。没有 Homebrew 通道。macOS 用户期望的是官方源里的短名：`brew install csi`。

进 **homebrew-core** 有两道硬门槛：

1. **许可证**：core 只收 DFSG / OSI 兼容许可证。仓库当前是 PolyForm Noncommercial 1.0.0，禁止商用，core 明确不收。
2. **构建**：core 公式必须从源码构建（用户侧靠 bottle，本机不必有 Go）。不能只分发 `csi-darwin-arm64.tar.gz` 这类预编译包。

0.5 的登录自启（`csi autostart`，无 KeepAlive）继续留给 curl 安装器。brew 通道改走 **brew services + KeepAlive**，和 `brew services stop` 语义对齐。

## 目标

1. 仓库许可证改为 **AGPL-3.0-only**（OSI/DFSG 里常用 copyleft 中最严的一档；允许商用，改过再分发或作为网络服务提供必须开源）。
2. 本仓库提供一份可审的 `Formula/csi.rb`：源码构建、`csi serve` + KeepAlive、caveats 写 `brew services start csi`。
3. 向 `Homebrew/homebrew-core` 投稿，目标用户命令是 `brew install csi`（无 `ximing/` 前缀）。合入前用本仓库 tap 过渡。
4. brew 托管的 daemon：`csi stop` / `csi restart` 拒绝并指向 `brew services`；`POST /restart` 只退出、让 launchd 拉起，避免双进程。
5. curl 安装器、Windows、`csi autostart` 语义不变。brew 只装 daemon。

成功标准：

- `LICENSE` 为 GNU AGPL v3 全文；README / 根 `package.json` 写 `AGPL-3.0-only`；不再出现「商用请开 issue」。
- `Formula/csi.rb` 能在 tap 下 `brew install --build-from-source` 产出 `csi version` 匹配 `version.go`。
- `CSI_BREW_SERVICE=1` 下 `POST /restart` 不 spawn 第二个 `serve`；`/status` 带 `supervisor: "brew-services"`；此时 `csi stop` / `csi restart` 非 0 退出。
- README 用表格写清 brew vs curl 两条生命周期。技能：不可达仍先 `csi start`；看到 brew 提示则让用户跑 `brew services start`，agent 不执行 `brew services stop/restart`。
- 不改工具清单；安全边界仍是 `127.0.0.1`、v1 无鉴权。
- 首个 AGPL 发版是**新 tag**，不改写已发布 Release。

## 非目标

- 不保证 Homebrew 一定把公式收入 core（知名度、CI、Go 版本由他们审）。本仓库做到可审并准备 PR 底稿。
- 不把 Chrome 扩展或技能打进 formula（core 公式不能依赖 cask；扩展继续商店 / sideload）。
- 不在 `post_install` 里 `brew services start`（core 会拒；装完由用户跑 caveats 里那一行）。
- 不改 Windows 安装器语义；不删除 `~/.csi/bin` 旧二进制。
- 不给每个源文件加 SPDX 头。
- 不在测试或实现过程中对本机执行 `brew services start/stop` / `csi autostart on/off` 作为副作用。
- 不为进 core 而降低 `go.mod` 的 Go 1.26 要求；投稿时若 Homebrew 的 `go` 公式低于 1.26，那次 PR 等 Go 公式升级后再提。

## 许可证

从 PolyForm Noncommercial 1.0.0 改为 **AGPL-3.0-only**。

含义（不是法律意见）：

- 个人、教育、政府、**公司商用**都可以按 AGPL 使用，不再需要另开 issue 买许可。
- 修改后分发二进制，或把修改过的 CSI 作为网络服务提供给外人，必须按 AGPL 提供对应源码。
- CSI 是本机 loopback daemon：普通「自己跑」一般不触发网络条款；被管住的是改过再分发 / 当服务对外提供。
- 选择 `-only` 而不是 `-or-later`：不允许被自动升级到未来的 AGPL 版本。这是「最严」的那一档。

文件：

| 文件 | 改动 |
|---|---|
| `LICENSE` | 换成 [GNU AGPL v3 官方全文](https://www.gnu.org/licenses/agpl-3.0.txt)。文首保留 `Copyright (c) 2025-2026 ximing (https://github.com/ximing)`。 |
| `README.md` / `README.zh-CN.md` | License 段改为 AGPL-3.0-only 及 GNU 链接；删掉 Noncommercial / 商用开 issue。Quick start 见下文。 |
| 根 `package.json` | `"license": "AGPL-3.0-only"` |
| `.github/workflows/release.yml` | 已把 `LICENSE` 拷进技能 tarball，随原文更新，不必改步骤。 |

`csi version` 或 `usage()` 增加一行 `License: AGPL-3.0-only`。

**版权门闩：** 仓库有外部 PR（例如 `winteraq`）。把别人在 PolyForm NC 下贡献的代码改成 AGPL，需要维护者确认贡献者同意或版权已在项目侧。实现许可证替换前，维护者必须明确过这一关；不能在规格或实现里假装已经获得同意。

## 两条安装通道

| | curl 安装器（现有） | Homebrew（新增） |
|---|---|---|
| 装什么 | daemon + 可选扩展 zip + 技能 | **只装 Go daemon** |
| 二进制 | `~/.csi/bin/csi` | Homebrew prefix（如 `/opt/homebrew/bin/csi`） |
| 运行时数据 | `~/.csi` | 同样 `~/.csi` |
| 生命周期 | `csi start` / `csi stop`；登录 `csi autostart`（无 KeepAlive） | `brew services` 托管 `csi serve`，**KeepAlive** |
| 停进程 | `csi stop` 之后保持停止 | `brew services stop csi`；`csi stop` 拒绝 |
| 扩展 / 技能 | 安装器或商店 | 商店 + 现有技能/插件安装 |

Windows 只有安装器。Linux Homebrew 与 macOS 共用同一份 formula。

合入 core 之前：

```bash
brew tap ximing/csi https://github.com/ximing/csi
brew install csi
brew services start csi
```

必须带 URL：短名 `brew tap ximing/csi` 会去克隆不存在的 `ximing/homebrew-csi`。

合入 core 之后，文档改成：

```bash
brew install csi
brew services start csi
```

`install.sh` / `install.ps1` 保留，作 Windows、技能、sideload 扩展、以及没有 Homebrew 的环境的通道。

## Formula

本仓库 `Formula/csi.rb` 是 tap 用的公式，也是向 homebrew-core 投稿的底稿。core 侧路径可能是 `Formula/c/csi.rb`（按字母分目录）；内容与本仓库对齐，不要维护两套语义。

要点：

- `homepage` `https://github.com/ximing/csi`
- `url` GitHub tag **源码**包：`https://github.com/ximing/csi/archive/refs/tags/v<version>.tar.gz`，`sha256` 钉死。禁止 Release 预编译 `csi-darwin-*.tar.gz`。
- `license "AGPL-3.0-only"`
- `depends_on "go" => :build`
- `install`：`cd "daemon"` 后 `system "go", "build", *std_go_args(ldflags: "-s -w"), "./cmd/csi"`。版本号已在 `version.go`，不另注入 ldflags。
- 可选 `head "https://github.com/ximing/csi.git", branch: "master"`
- **没有** `post_install` 自启
- `test do`：`assert_match version.to_s, shell_output("#{bin}/csi version")`。不起 daemon、不 bind 端口、不碰 launchctl。
- 版本字符串与 `daemon/internal/version/version.go` 一致。发 tag 后更新本仓库 formula 的 `url`/`sha256`；进 core 后用 `brew bump-formula-pr`。

`service`：

```ruby
service do
  run [opt_bin/"csi", "serve"]
  keep_alive true
  environment_variables CSI_BREW_SERVICE: "1"
  log_path var/"log/csi.log"
  error_log_path var/"log/csi.log"
end
```

用户级 agent（不要 `require_root`）。label 由 Homebrew 生成，约 `homebrew.mxcl.csi`。日常滚动日志仍在 `~/.csi/logs`；brew 再接一份 stdout。

`caveats` 必须写清：

1. 现在就启动并登录保活：`brew services start csi`
2. 停 / 重启用 `brew services stop|restart csi`，不要 `csi stop` / `csi restart`（KeepAlive 会拉回来；CLI 也会拒绝）
3. 扩展：Chrome 商店（或 sideload `~/.csi/extension`）
4. 若本机以前用过 curl 安装器：先停掉旧进程（`csi stop` 或 `~/.csi/bin/csi stop`），再 `brew services start csi`，避免抢 `10088`

向 core 投稿：在可审 tag（已是 AGPL）之后，对 `Homebrew/homebrew-core` 开 PR，本地先 `brew audit --new --formula csi`。收不收、bottle 由他们 CI 决定。core 未合入时 README 写 tap；合入后改短名。

## brew 生命周期与 daemon 行为

### 环境变量

Homebrew service 注入 `CSI_BREW_SERVICE=1`。只出现在 **launchd/systemd 拉起的 `serve` 进程**里，用户 shell 里的 `csi stop` 看不到它。

### `GET /status`：`supervisor`

这是 **HTTP 契约的加字段**，不是新工具。按协议同步规则，先改 `docs/protocol.md` §2.2，再改实现。工具清单、WS `tool_call` 形状、hello.tools 都不动。旧客户端忽略未知 JSON 键。

当且仅当 `CSI_BREW_SERVICE=1` 时：

```json
"supervisor": "brew-services"
```

否则 **省略**该字段（不要发空字符串，避免客户端还要分辨空和缺省）。

`/status` 其它字段不变。不 bump 协议版本号（无新工具）。已经发布的 tag（例如 `v0.6.0`）保持历史许可证，禁止重打。AGPL 落在下一个新 tag 上，Formula 的 `url` 钉这个 tag。号码取当时 `version.go` 的下一个补丁或主线已更高的版本；版本字符串表面与既有发版清单相同（`version.go`、扩展 manifest、技能 metadata、插件清单、站点 i18n）。

### `POST /restart`

`cmdServe` 设置 `Restarter` 时：若 `CSI_BREW_SERVICE=1`，Restarter **只安排本进程优雅退出**，禁止 `spawnReplacement`。KeepAlive 拉起的新 `serve` 会读新的 `~/.csi/config.json`，设置页改端口后轮询 `/healthz` 的路径继续成立。

非 brew 通道保持今天的「detached 新 serve + 自己退出」。

### `csi stop` / `csi restart`

这两个命令先打 `/status`（已有身份校验路径）：

- 若 JSON 含 `"supervisor": "brew-services"`：打印明确错误（指向 `brew services stop|restart csi`），退出码非 0，**不发信号**。`--force` 同样拒绝（强杀也会被 KeepAlive 拉回）。
- 否则行为与现在完全一样。

daemon 没在跑时：现有 `csi not running`，不变。

### `csi start`

已有进程且身份匹配：仍 no-op。文档写明：brew 用户请用 `brew services start`；在 brew service 已 `stop` 时跑 `csi start` 会拉起一个没有 KeepAlive 的后台进程，不要这样做。

### 与 curl autostart 互斥

两套监督不能同时盯 `10088`：`ai.csi.daemon`（`csi autostart`）和 `homebrew.mxcl.csi`。

`serve` 在 `CSI_BREW_SERVICE=1` 下启动时，幂等调用现有 `autostart.Disable`（只拆 `ai.csi.daemon` plist / linux user unit / Windows Run 值，不动 Homebrew 的 agent）。失败记日志，不让 `serve` 失败。

若旧的 `~/.csi/bin/csi` 已经占用端口：`brew services start` 会起不来。靠 caveats / README 的接管步骤，公式不在 install 时杀用户进程。

不删除 `~/.csi/bin`。

curl 通道：无 KeepAlive，`csi stop` 保持停止，`csi autostart` 不变。

## 文档与技能

- README 中英 Quick start：macOS 推荐 brew（core 未合入时写 tap + `brew services start`）。curl 安装器改为备选，并保留 Windows 段落。用表格对比两条通道的 stop/restart。
- `skills/csi/SKILL.md` 与 `references/operations.md`：
  - daemon 不可达仍先自己 `csi start`（幂等；brew 已在跑则 no-op）。
  - 若 `csi start` / `csi stop` 的输出要求使用 `brew services`，把命令告诉用户，**不要**自己执行 `brew services start/stop/restart`（与 `csi stop` / `autostart on|off` 同档：改机器上的托管方式）。
  - Do-not-run 列表加上 `brew services stop` / `brew services restart`。
- `daemon/CLAUDE.md`：补 `CSI_BREW_SERVICE`、`/status.supervisor`、brew 通道禁止 KeepAlive 之外再 spawn。
- `scripts/CLAUDE.md`：注明 brew 是第三条安装通道，旗标 parity 仍只约束 `install.sh` / `install.ps1`。

## 测试

Go（`cd daemon && go test ./... && go vet ./...`）：

- `/status`：默认无 `supervisor`；`CSI_BREW_SERVICE=1` 时为 `brew-services`。
- Restarter：env 置位时不调用 spawn；未置位时仍 spawn（可注入 fake）。
- `csi stop` / `csi restart`：对带 `supervisor` 的假 `/status` 拒绝且不杀进程。
- brew `serve` 启动路径调用 `autostart.Disable`：用 fake，禁止测到本机 `~/Library/LaunchAgents`。

Formula：能跑则 `brew audit --formula Formula/csi.rb`（或 `--new`）；至少保证 Ruby 语法能加载。`test do` 只覆盖 `csi version`。

禁止：单测对本机 `brew services start/stop`、`csi autostart on/off`、长期占用 `10088`。

## 实现顺序

1. 维护者确认外部贡献可改为 AGPL。
2. `docs/protocol.md` §2.2 加上可选 `supervisor`（协议先行）。
3. daemon：env、`/status`、Restarter、stop/restart 拒绝、brew serve 时 `autostart.Disable`、usage/version 许可证行。
4. `LICENSE` + README + `package.json`。
5. `Formula/csi.rb` + 技能 / CLAUDE 文档。
6. 版本字符串 bump 到首个 AGPL 发版号，打**新** tag（不改写旧 Release）。之后再向 homebrew-core 开 PR（可另一次操作；不阻塞本仓库分支合并）。

零协议工具变更：四处工具表不必因本规格改动。`supervisor` 只出现在 `/status` 与协议 §2.2。
