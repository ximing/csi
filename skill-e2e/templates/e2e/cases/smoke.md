# smoke 验收（csi 驱动）

前置：被测 URL: https://example.com
启动：无需启动（公网站点，仅验证 e2e 脚手架与 csi 链路可用）
每步后附【预期】。失败即终止并回报。

## 1. 页面内容
- 打开 https://example.com
- 【预期】document.title 为 `Example Domain`；h1 文本为 `Example Domain`

## 2. 链接跳转
- 点击 "Learn more" 链接
- 【预期】URL 跳到 iana.org 域名下（`location.hostname` 以 `iana.org` 结尾）
