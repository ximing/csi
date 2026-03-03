# Case format — writing e2e/cases/<name>.md

A case file is the source of truth for one test suite: written before verification, updated during it, and linked from the suite script after solidification. The suite name must match the case name (`cases/login.md` ↔ `suites/login.mjs`).

## Structure

```markdown
# <name> 验收（csi 驱动）

前置：被测 URL: https://the-internet.herokuapp.com/login
启动：无需启动（公网站点）        # 或：pnpm --filter ./apps/web dev（仓库根，端口 5180）
账号：tomsmith / SuperSecretPassword!   # 测试账号、测试数据、相关存储键都写这里
每步后附【预期】。失败即终止并回报。

## 1. 登录成功
- 打开登录页，用户名输入 tomsmith，密码输入 SuperSecretPassword!，点 Login
- 【预期】URL 变为 /secure，页面出现 "You logged into a secure area!"

## 2. 密码错误
- 重新打开登录页，用户名 tomsmith，密码输入 wrong，点 Login
- 【预期】停留在 /login，出现 "Your password is invalid!"
```

## Rules

1. **Header declares everything the runner doesn't know.** The scaffold is deliberately app-agnostic: the URL, the dev-server command, test accounts, relevant localStorage keys — all live in the case header. During verification you follow the header; during solidification `openPage()` takes the URL from here.

2. **Expectations must be machine-checkable.** Write the concrete value or text ("标题为 Example Domain", "localStorage 键 xexcel.workbook 非空"), never "显示正常" / "能打开". If you can't state the expected value yet, verify the step manually first and fill it in from what you observe.

3. **Steps at UI-action granularity.** "在 A1 输入 1，选中 B1 拖填充柄到 B3" — not "调用 setCell API". The case describes what a user does; how to fake it (synthetic events, evaluate) is the suite's business.

4. **Known limitations are expectations too.** If the product currently shows `#REF!` after a sheet rename and that's accepted, write it as the expectation, marked 已知限制. A case documents actual agreed behavior, not ideal behavior.

5. **Cleanup assumptions.** If a scenario depends on state left by an earlier one (same archive, same session), say so explicitly. Suites run scenarios in order, fast-fail on first error.

6. **Keep it in the user's language.** These files are read by humans during review; write steps and expectations in whatever language the user speaks.

## Anti-patterns

- Don't write selectors or `@e` refs into the case ("点击 @e12") — cases are UI-level; selectors are a solidification-time decision.
- Don't batch unrelated flows into one case. One case = one feature area; scenarios inside it share setup.
- Don't hide flakiness in the description ("等 3 秒再看"). If a wait condition matters, name the condition ("等到 loading 消失"), not a duration.
