# read-wait 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932）
覆盖工具：evaluate / cdp / wait / snapshot（读断言）
每步后附【预期】。失败即终止并回报。

## 1. evaluate 读页面状态
- 打开主页，evaluate 返回 { title, h1, 表单是否存在 }
- 【预期】{ title: "CSI Testbed", h1: "CSI 回归靶场", hasForm: true }

## 2. cdp 直发协议调用
- 通过 cdp 工具发 Runtime.evaluate 表达式 location.host
- 【预期】返回值为 "127.0.0.1:8931"

## 3. wait 等延迟元素出现
- click "点我，1 秒后出现结果" 按钮，wait 等待 #delayed 元素出现
- 【预期】wait 成功返回；页面文本含 "延迟内容已出现"

## 4. wait 等 URL 变化
- 点击导航里 "第二页" 链接（evaluate click），wait 等待 url 包含 second.html
- 【预期】wait 成功；location.pathname 为 /second.html
