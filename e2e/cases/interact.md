# interact 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932）
覆盖工具：snapshot / click / fill / key_type / send_keys / mouse_click / hover / scroll
每步后附【预期】。失败即终止并回报。

## 1. snapshot 出树带 @e
- 打开主页，执行 snapshot（interactive 模式）
- 【预期】树中含 textbox "用户名"、button "登录"，均带 [ref=@eN]

## 2. fill + click 提交表单
- fill 用户名输入框为 "e2e用户"，fill 密码框为 "pass123"，click 登录按钮
- 【预期】出现状态文本 "登录成功: e2e用户 / pass123 / remember=false / role=user"

## 3. checkbox 与 select 改变提交结果
- click "记住我" checkbox（合成 click 对 checkbox 生效）；select 用 evaluate 设 value=admin 并发 change 事件（已验证：合成 click 点击 <option> 不改变 select 值）；再次 click 登录按钮
- 【预期】状态文本变为 "登录成功: e2e用户 / pass123 / remember=true / role=admin"

## 4. key_type 与 send_keys
- fill 清空用户名，evaluate 让其 focus（已验证：click 工具是 DOM 级 el.click()，不移动焦点），key_type 输入 "ab"，send_keys 发送 Backspace
- 【预期】用户名输入框最终值为 "a"

## 5. mouse_click 坐标点击
- mouse_click 点击密码框（tab 需在前台，openPage 已 bringToFront）
- 【预期】document.activeElement 为密码框（坐标级事件会真实移动焦点）

## 6. hover 展开菜单
- 对 "把鼠标放上来" 触发 hover
- 【预期】"隐藏菜单内容" 变为可见（offsetParent 非 null）

## 7. scroll 到底部
- scroll direction=down 大 amount
- 【预期】"到底了" 进入视口（getBoundingClientRect().top < innerHeight）
