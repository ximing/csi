# tabs 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/ 与 http://localhost:8931/second.html
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932，同绑 IPv4/IPv6 回环）
覆盖工具：navigate / list_tabs / find_tab / close_tab / close_session
已知约束：find_tab 按 **hostname** 匹配（extension/src/background/tools/find-tab.ts 的
`toHostPattern`），路径被忽略；同 host 的两个 tab 无法区分。因此本用例用
127.0.0.1 与 localhost 两个 host 各开一个 tab 来验证切换。
每步后附【预期】。失败即终止并回报。

## 1. 打开主页并枚举
- navigate 打开 http://127.0.0.1:8931/ （新 tab），随后 list_tabs
- 【预期】list_tabs 里存在标题为 "CSI Testbed"、url 为 http://127.0.0.1:8931/ 的 tab

## 2. find_tab 在两个 host 间切换当前 tab
- 再 navigate 打开 http://localhost:8931/second.html（新 tab）
- find_tab url=http://127.0.0.1:8931/ → 【预期】返回主页 tab；evaluate location.href 为主页
- find_tab url=http://localhost:8931/second.html → 【预期】返回第二页 tab；location.href 为 second.html

## 3. close_tab 关掉当前 tab
- （当前 tab 为第二页）执行 close_tab，随后 list_tabs
- 【预期】list_tabs 里不再有 localhost 的 tab，主页 tab 仍在

## 4. close_session 收尾
- 执行 close_session，随后 list_tabs
- 【预期】本 session tab 列表为空
