# skill 目录说明

## 这个目录负责什么

`csi` Claude Code 技能的源码：安装器把它原样拷到 `~/.claude/skills/csi/`。技能教模型通过 daemon 的 HTTP API 驱动真实浏览器。

## 放置约束

- `SKILL.md` 是主文件，**预算 ≤1200 tokens（cl100k_base，CI 强制）**：只放 frontmatter 触发边界、默认工作流、session 规则、`@e` 优先原则、reference 路由表和 daemon 不可达时的单句恢复；细节一律下沉到 `references/`。
- frontmatter 的 `description` 同时包含**正向触发**（browser/webpage/screenshot 等）与**排除边界**（只讨论概念不打开页面、headless/隔离 profile/纯 HTTP 抓取、代码审查里出现字样），两类都要保留。
- `references/` 六个文件：`http-transport.md`（调用格式 + 错误信封 + **21 个工具的索引表**）、`tabs-and-sessions.md`、`interaction.md`、`frames.md`、`large-results.md`、`operations.md`。工具参数只写在对应 reference，不复制回 SKILL.md。
- 工具清单一致性由 CI 强制：`docs/protocol.md` §4 = daemon `validTools` = MCP `toolDefs` = extension registry = `references/http-transport.md` 的工具索引表（`.github/workflows/skill-ci.yml`）。加/改工具时 `protocol.md` 先行，这五处一起改。

## 开发偏好

- 写作对象是"使用技能的模型"，不是人类读者：指令要直接、可执行，避免营销化描述。
- `references/` 内互相引用用相对文件名（如 `tabs-and-sessions.md`），SKILL.md 引用用 `references/xxx.md`；CI 会检查链接存在。
- 改完后技能的实际生效位置是 `~/.claude/skills/csi/`，本地仓库这份是源；验证时记得同步或重装。
