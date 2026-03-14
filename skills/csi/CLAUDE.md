# skill 目录说明

## 这个目录负责什么

`csi` Claude Code 技能的源码：安装器把它原样拷到 `~/.claude/skills/csi/`。技能教模型通过 daemon 的 HTTP API 驱动真实浏览器。

## 放置约束

- `SKILL.md` 是主文件，frontmatter 的 `description` 决定触发时机，改动要克制但保持触发词覆盖（browser/webpage/screenshot 等）。
- `SKILL.md` 里的工具表格必须与 `docs/protocol.md` §4 保持同步——加/改工具时这里是必改点之一。
- `references/` 放按需加载的深度文档（如 `operations.md`），正文中用相对链接引用，不要把大段内容塞回 `SKILL.md`。

## 开发偏好

- 写作对象是"使用技能的模型"，不是人类读者：指令要直接、可执行，避免营销化描述。
- 改完后技能的实际生效位置是 `~/.claude/skills/csi/`，本地仓库这份是源；验证时记得同步或重装。
