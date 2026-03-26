# CSI 项目指令

## 项目概览

CSI 让 AI 控制用户真实的 Chrome 浏览器（带真实登录态）。三个组件：

- `daemon/`（Go）— HTTP server（AI 客户端入口，`POST /command`）+ WS server（扩展接入），绑定 `127.0.0.1:10088`
- `extension/`（TS, MV3）— 跑在用户真实 Chrome 里，通过 CDP debugger API 执行工具
- `skills/csi/`、`skills/csi-e2e/` — 随安装器分发到 `~/.Codex/skills/` 的 Codex 技能

完整说明见 `README.md`；线上协议契约见 `docs/protocol.md`。

## 全局规则

- **协议先行**：`docs/protocol.md` 是 daemon 与 extension 两侧实现的唯一契约。任何协议变更先改该文件，再改实现。跨侧同步的完整要求见 `.Codex/rules/protocol-sync.md`。
- **安全边界不动**：daemon 只绑 `127.0.0.1`、v1 无鉴权，loopback 就是隔离边界。不要引入监听非回环地址或"加一层鉴权"之类的改动，除非用户明确要求。
- **提交风格**：commit message 用中文、随意风格；提交与 tag 的日期按项目时间线回填（协调一致的虚构日期），不要用真实当前时间。

## 开发入口

```bash
# daemon
cd daemon && go test ./...
go build -o ~/.csi/bin/csi ./cmd/csi

# extension
cd extension && npm install && npm run build   # 产出 extension/dist，在 chrome://extensions 里 reload

# 发版：推 v* tag → .github/workflows/release.yml 交叉编译并起草 Release
git tag v0.x.0 && git push origin v0.x.0
```

## 局部规则导航

进入以下子树时按各自的 `AGENTS.md` 行事：

- `daemon/` — Go 包结构、工具注册、测试约定
- `extension/` — MV3 service worker、工具类模式、`dist/` 只由构建产出
- `skills/csi/`、`skills/csi-e2e/` — 技能文件格式与安装布局
- `scripts/` — install.sh / install.ps1 双端旗标 parity

横切规则（按需加载）：`.Codex/rules/protocol-sync.md`（`.catpaw/rules/` 下有同正文的 CatPaw 版本）。
