// smoke suite（叙述版见 e2e/cases/smoke.md）：验证 e2e 脚手架与 csi 链路可用。
import { evaluateJS } from '../lib/bridge.mjs'
import { openPage, pollUntil } from '../lib/env.mjs'

const URL_UNDER_TEST = process.env.E2E_URL || 'https://example.com'

export default async function run({ assertEq }) {
  await openPage(URL_UNDER_TEST)

  // ---- 场景 1：页面内容 ----
  async function s1() {
    await pollUntil(`document.readyState === 'complete'`, 'S1 页面加载完成')
    const r = await evaluateJS(`return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent ?? null,
    }`)
    assertEq(r, { title: 'Example Domain', h1: 'Example Domain' }, 'S1 标题与 h1')
  }

  // ---- 场景 2：链接跳转 ----
  async function s2() {
    // example.com 唯一锚文本链接；无 aria-label 时按文本定位是稳定选择
    await evaluateJS(`
      const a = [...document.querySelectorAll('a')].find((x) => x.textContent.includes('Learn more'))
      if (!a) throw new Error('未找到 Learn more 链接')
      a.click()
      return true`)
    await pollUntil(`location.hostname.endsWith('iana.org')`, 'S2 跳到 iana.org')
  }

  const scenarios = [
    ['1 页面内容', s1],
    ['2 链接跳转', s2],
  ]
  for (const [name, fn] of scenarios) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (e) {
      console.error(`  ✗ ${name}`)
      throw e // 快速失败：断言失败即终止 suite
    }
  }
}
