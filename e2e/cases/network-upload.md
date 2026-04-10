# network-upload 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932）
覆盖工具：network / upload
每步后附【预期】。失败即终止并回报。

## 1. network 抓到 fetch
- 打开主页，click "发一个 fetch" 按钮，等页面出现结果后用 network 读请求记录
- 【预期】页面出现 {"hello":"csi","seq":[1,2,3]}；network 记录中存在 GET /api/data.json 且状态 200

## 2. upload 设置文件并回显
- 准备文件 e2e/artifacts/upload-me.txt（内容任意，runner 自建），upload 到 "选择文件" 输入框
- 【预期】页面出现 "已选择: upload-me.txt (" 前缀的回显文本
