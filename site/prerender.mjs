// 构建后预渲染:把 dist/index.html(带 %TOKEN% 占位符)渲染成 zh/en 两份静态 HTML。
// 用法:vite build && vite build --ssr src/entry-server.tsx --outDir dist-ssr && node prerender.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { render } from './dist-ssr/entry-server.js'

const template = readFileSync('dist/index.html', 'utf8')

const PAGES = {
  zh: {
    out: 'dist/index.html',
    htmlLang: 'zh-CN',
    title: 'CSI — 让 AI 用真实登录态操控你的 Chrome 浏览器 | AI Browser Automation',
    desc: 'CSI 让 AI(Claude Code 等 agent)直接操控你真实的 Chrome 浏览器:导航、点击、输入、读页面、截图、存 PDF,全程使用你真实的登录态。Let AI agents control your real Chrome browser with your actual login sessions.',
    canonical: 'https://ximing.github.io/csi/',
    ogLocale: 'zh_CN',
    ogLocaleAlt: 'en_US',
    ogUrl: 'https://ximing.github.io/csi/',
    initialLang: "window.__INITIAL_LANG__='zh';",
  },
  en: {
    out: 'dist/en/index.html',
    htmlLang: 'en',
    title: 'CSI — Let AI Agents Control Your Real Chrome Browser | AI Browser Automation',
    desc: 'CSI lets AI agents (Claude Code and others) drive your real Chrome browser — navigate, click, type, read pages, take screenshots, save PDFs — with your actual login sessions. 让 AI 用你真实的登录态操控 Chrome。',
    canonical: 'https://ximing.github.io/csi/en/',
    ogLocale: 'en_US',
    ogLocaleAlt: 'zh_CN',
    ogUrl: 'https://ximing.github.io/csi/en/',
    initialLang: "window.__INITIAL_LANG__='en';",
  },
}

for (const [lang, p] of Object.entries(PAGES)) {
  const html = template
    .replace('__HTML_LANG__', p.htmlLang)
    .replace('__PAGE_TITLE__', p.title)
    .replace('__PAGE_DESC__', p.desc)
    .replace('__CANONICAL__', p.canonical)
    .replace('__OG_LOCALE__', p.ogLocale)
    .replace('__OG_LOCALE_ALT__', p.ogLocaleAlt)
    .replace('__OG_URL__', p.ogUrl)
    .replace('__APP_HTML__', () => render(lang))
    .replace('__INITIAL_LANG__', p.initialLang)

  mkdirSync(new URL(`file://${process.cwd()}/${p.out}/..`).pathname, { recursive: true })
  writeFileSync(p.out, html)
  console.log(`prerendered ${p.out}`)
}
