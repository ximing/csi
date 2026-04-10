# capture 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932）
覆盖工具：screenshot（视口 + fullPage）/ save_as_pdf
产物目录：e2e/artifacts/（daemon 按字面 path 落盘，父目录自建）
每步后附【预期】。失败即终止并回报。

## 1. 视口截图
- 打开主页，screenshot 到 e2e/artifacts/capture-viewport.png
- 【预期】文件存在且大小 > 10KB，是 PNG（头字节 89 50 4E 47）

## 2. fullPage 截图
- screenshot fullPage 到 e2e/artifacts/capture-full.png
- 【预期】文件存在；PNG 高度明显大于视口截图高度（页面有 1500px 滚动区）

## 3. save_as_pdf
- save_as_pdf 到 e2e/artifacts/capture.pdf
- 【预期】文件存在且以 %PDF 开头，大小 > 5KB
