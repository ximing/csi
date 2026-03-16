# CSI 宣传页设计

- 日期: 2026-03-16
- 状态: 已批准
- 技术栈: Vite + React + TypeScript
- 托管: GitHub Pages（项目站点 `ximing.github.io/csi/`）
- 部署: GitHub Actions（官方 `deploy-pages`，非 gh-pages 分支）

## 目标

为 CSI 做一个宣传落地页，直观传达核心卖点「AI 操控真实 Chrome」。定位为**静态宣传 + 伪演示动画**：无真实 daemon 依赖，GitHub Pages 零摩擦托管，访客无需任何环境即可浏览。视觉走**暗色·案发现场科技风**，呼应 CSI 双关名（Ctrl+Shift+I / Crime Scene Investigation）。

## 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 页面定位 | 静态宣传 + 伪演示动画 | GitHub Pages 零摩擦，无 daemon 依赖，视觉冲击强 |
| 视觉调性 | 暗色·案发现场科技风 | 贴合 CSI 双关名，辨识度高 |
| 演示形态 | 单段循环 hero 演示 | 最小最聚焦，落地即见核心卖点 |
| 部署方式 | 官方 Pages Actions | 不占 `/docs`（已被协议文档占用），不维护额外分支 |
| 国际化 | 双语，默认中文 | 与项目中文导向一致，呼应刚做的双语 README |
| i18n 实现 | 纯 key-value + React context | 不引 i18next（YAGNI） |
| 动画实现 | React state + setTimeout | 不引动画库（YAGNI） |

## 仓库结构

```
csi/
├── site/                       # Vite + React + TS 宣传页（新增）
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── i18n/               # zh.ts / en.ts，纯 key-value
│   │   ├── components/
│   │   │   ├── Nav.tsx             # 顶栏：案卷编号 + 中/EN + GitHub
│   │   │   ├── Hero.tsx            # hero 标题 + CTA
│   │   │   ├── HeroDemo.tsx        # 循环演示动画（终端 + 浏览器框联动）
│   │   │   ├── Features.tsx        # 核心卖点卡
│   │   │   ├── Architecture.tsx    # 架构图 SVG 重绘
│   │   │   ├── Tools.tsx           # 17 工具网格
│   │   │   ├── QuickStart.tsx      # 安装命令 + 复制按钮
│   │   │   ├── E2E.tsx             # csi-e2e 四步流程
│   │   │   ├── Security.tsx        # 安全说明
│   │   │   ├── Footer.tsx
│   │   │   └── LangToggle.tsx      # 中/EN 切换（React context）
│   │   ├── styles/             # 暗色案发现场主题 CSS
│   │   └── data/tools.ts       # 17 工具名 + 一句话描述
│   ├── index.html
│   ├── vite.config.ts          # base: '/csi/'
│   ├── tsconfig.json
│   └── package.json
├── .github/workflows/
│   └── deploy-site.yml         # 新增：构建并部署 Pages
└── ...(既有文件不动）
```

既有文件不动。`site/` 是独立子目录，自己的 `package.json`，不与 daemon/extension 共享依赖。

## 页面章节（自上而下）

1. **Nav** — 左：CSI 案卷编号 `#CSI-10088`；右：`中/EN` 切换、GitHub 链接。
2. **Hero** — 大标题「AI 勘查浏览器案发现场」+ 副标题 + CTA（快速开始 / 查看 17 件工具）；下方嵌 `HeroDemo` 循环动画。
3. **Features** — 4 张卡：真实登录态 / 17 工具 / 无自动化标记 / Claude Code 技能自动启用。
4. **Architecture** — 架构图 SVG 重绘（AI client → daemon → extension，源自 README）。
5. **Tools** — 17 工具网格，每卡：工具名（mono）+ 一句话。
6. **QuickStart** — 安装命令块 + 复制按钮，macOS/Linux 与 Windows 两 tab。
7. **E2E** — csi-e2e 四步流程（描述→验证→固化→重放）。
8. **Security** — 两条：loopback 隔离 / `evaluate`+`cdp` 是设计能力。
9. **Footer** — GitHub、README、protocol.md 链接 + 版本号。

## Hero 伪演示动画（HeroDemo.tsx）

自动循环，~8 秒一轮，React state + `setTimeout` 驱动步骤，不引动画库。

步骤序列：
1. 终端逐字打出 `POST /command navigate → example.com`
2. 浏览器框出现，地址栏加载，页面渲染占位
3. 终端打出 `POST /command click → @e-login`
4. 浏览器框对应元素高亮 + 点击波纹
5. 终端打出 `POST /command screenshot`
6. 截图缩略图从浏览器框「拍」出，带「证据 #001」胶带标签
7. 短暂停留 → 重置循环

视觉：终端黑底 mono 绿字 + 闪烁光标；浏览器框圆角深灰 + 模拟 Chrome 标签栏；扫描线/网格背景；黄黑「案发现场」胶带点缀。

无障碍：`prefers-reduced-motion` 下停动画，显示静态终态帧。

## 部署 workflow（deploy-site.yml）

- 触发：push to master 且 `site/**` 或 workflow 变更；+ 手动 `workflow_dispatch`。
- 权限：`pages: write`、`id-token: write`。
- 步骤：checkout → setup-node 20 → `cd site && npm ci && npm run build` → `upload-pages-artifact path: site/dist` → `deploy-pages`。
- Pages source 设为 **"GitHub Actions"**（需在 Repo Settings → Pages 设一次，交付说明会写）。
- `base: '/csi/'` 保证 `ximing.github.io/csi/` 下资源不 404。

## 测试与验证

- `cd site && npm run build` 通过（Vite build 含 tsc 类型检查）。
- 本地 `npm run dev` 验收动画循环、双语切换、复制按钮。
- 推送后 Actions 绿、Pages 可访问、资源不 404。
- 纯静态展示页，不写单元测试（YAGNI），靠 build + 视觉验收。

## 范围外

- 不做真 live demo（连本地 daemon）——HTTPS/HTTP 混合内容拦截 + 访客需预装环境，不可行。
- 不做多场景切换演示——单段循环已足够传达核心卖点。
- 不引 i18next / 动画库 / UI 组件库——纯手写，控制体量与依赖。
- 不动既有 daemon/extension/skills 代码。
