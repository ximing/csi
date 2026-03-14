# skill-e2e 目录说明

## 这个目录负责什么

`csi-e2e` Claude Code 技能的源码：把自然语言浏览器场景变成可回放的 e2e 回归套件（describe → verify → solidify → replay）。安装器把它原样拷到 `~/.claude/skills/csi-e2e/`。

## 放置约束

- `SKILL.md` 是主文件；`references/` 放按需加载的格式文档（`workflow.md`、`case-format.md`、`suite-translation.md`）。
- `templates/e2e/` 是技能在用户项目里 scaffold 出来的 `e2e/` 目录模板（`run.mjs` 等）——套件运行时不依赖任何测试框架，只要求 Node ≥ 18，保持这个零依赖约束。
- case（`cases/*.md`）与 suite（`suites/*.mjs`）的格式以 `references/case-format.md`、`references/suite-translation.md` 为准，改格式先改这两份文档。

## 开发偏好

- 套件脚本直接对 daemon 发 HTTP（`POST /command`），不要引入 ws 直连或 npm 依赖。
- 改完后技能的实际生效位置是 `~/.claude/skills/csi-e2e/`，本地仓库这份是源；验证时记得同步或重装。
