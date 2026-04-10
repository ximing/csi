# iframe 验收（csi 驱动）

前置：被测 URL: http://127.0.0.1:8931/frames.html
启动：`node e2e/testbed/serve.mjs`（仓库根，端口 8931/8932；8932 = 跨源）
覆盖工具：list_frames / snapshot（进同域帧）/ click·fill·evaluate（frame 参数）
每步后附【预期】。失败即终止并回报。

## 1. list_frames 列出两个帧
- 打开 frames.html，执行 list_frames
- 【预期】返回两个子帧：一个 url 为 http://127.0.0.1:8931/frame.html 且 isolated=false；一个 url 为 http://127.0.0.1:8932/frame.html 且 isolated=true

## 2. snapshot 进同域 iframe
- 对同域帧执行 snapshot（frame 传未截断 URL 子串 "8931/frame.html"；手测时对 iframe @e 再 snapshot 亦可）
- 【预期】树中出现 "帧内输入"、"帧内按钮"，各自带 @e；url 为 http://127.0.0.1:8931/frame.html

## 3. frame 参数在帧内交互
- fill 帧内输入框（frame="8931/frame.html"）为 "帧内abc"，click 帧内按钮，evaluate 读 #frame-flash 文本（带 frame）
- 【预期】帧内状态文本为 "帧内收到: 帧内abc"

## 4. 跨域帧报人话
- 对跨域帧尝试 evaluate（frame="8932/frame.html"）
- 【预期】返回可读错误：含 "cross-origin"，提示可 navigate 到其 URL（非崩溃非超时）
