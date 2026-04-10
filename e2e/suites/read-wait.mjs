// read-wait suite（叙述版见 e2e/cases/read-wait.md）：evaluate / cdp / wait
import { cmd, evaluateJS } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const MAIN = 'http://127.0.0.1:8931/'

export default async function run({ assertEq }) {
  await openPage(MAIN)

  async function s1() {
    const r = await evaluateJS(`return {
      title: document.title,
      h1: document.querySelector('h1').textContent,
      hasForm: !!document.getElementById('login-form'),
    }`)
    assertEq(r, { title: 'CSI Testbed', h1: 'CSI 回归靶场', hasForm: true }, 'S1 标题与 h1')
  }

  async function s2() {
    const r = await cmd('cdp', {
      method: 'Runtime.evaluate',
      params: { expression: 'location.host', returnByValue: true },
    })
    assertEq(r.result.value, '127.0.0.1:8931', 'S2 cdp 直发 Runtime.evaluate')
  }

  async function s3() {
    await cmd('click', { selector: '#delay-btn' })
    const w = await cmd('wait', { selector: '#delayed', timeout_ms: 5000 })
    if (!w.success) throw new Error('S3 wait #delayed 未命中')
    assertEq(
      await evaluateJS('return document.getElementById("delayed").textContent'),
      '延迟内容已出现',
      'S3 延迟元素文本',
    )
  }

  async function s4() {
    await evaluateJS(`
      [...document.querySelectorAll('a')].find((a) => a.textContent.includes('第二页')).click()
      return true`)
    const w = await cmd('wait', { url: 'second.html', timeout_ms: 5000 })
    if (!w.success) throw new Error('S4 wait url 未命中')
    assertEq(await evaluateJS('return location.pathname'), '/second.html', 'S4 跳到第二页')
  }

  const scenarios = [
    ['1 evaluate 读页面状态', s1],
    ['2 cdp 直发协议调用', s2],
    ['3 wait 等延迟元素', s3],
    ['4 wait 等 URL 变化', s4],
  ]
  for (const [name, fn] of scenarios) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (e) {
      console.error(`  ✗ ${name}`)
      throw e
    }
  }
}
