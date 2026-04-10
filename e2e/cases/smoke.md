# smoke 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932）
用途：验证 e2e 脚手架与 csi 链路本身可用（导航 + 读页面 + 链接跳转）。
每步后附【预期】。失败即终止并回报。

## 1. 页面内容
- 打开主页
- 【预期】标题为 "CSI Testbed"，h1 为 "CSI 回归靶场"

## 2. 链接跳转
- 点击导航里 "第二页" 链接
- 【预期】location.pathname 变为 /second.html
