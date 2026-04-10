// tabs suite（叙述版见 e2e/cases/tabs.md）：navigate / list_tabs / find_tab / close_tab / close_session
import { cmd, evaluateJS } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const MAIN = 'http://127.0.0.1:8931/'
// find_tab 按 hostname 匹配（见 case 已知约束），第二页用 localhost 区分于 127.0.0.1
const SECOND = 'http://localhost:8931/second.html'

export default async function run({ assertEq }) {
  await openPage(MAIN)

  async function s1() {
    const { tabs } = await cmd('list_tabs')
    const main = tabs.find((t) => t.url === MAIN)
    if (!main) throw new Error(`list_tabs 未含主页: ${JSON.stringify(tabs)}`)
    assertEq(main.title, 'CSI Testbed', 'S1 主页标题')
  }

  async function s2() {
    await cmd('navigate', { url: SECOND, newTab: true })
    const r1 = await cmd('find_tab', { url: MAIN })
    assertEq(r1.url, MAIN, 'S2 find_tab 命中主页')
    assertEq(await evaluateJS('return location.href'), MAIN, 'S2 当前 tab 为主页')
    const r2 = await cmd('find_tab', { url: SECOND })
    assertEq(r2.url, SECOND, 'S2 find_tab 命中第二页')
    assertEq(await evaluateJS('return location.href'), SECOND, 'S2 当前 tab 为第二页')
  }

  async function s3() {
    // 依赖 S2：当前 tab 是第二页
    await cmd('close_tab')
    const { tabs } = await cmd('list_tabs')
    if (tabs.some((t) => t.url.includes('localhost'))) {
      throw new Error('S3 close_tab 后 localhost tab 仍在')
    }
    if (!tabs.some((t) => t.url === MAIN)) throw new Error('S3 主页 tab 被误关')
  }

  async function s4() {
    await cmd('close_session')
    const { tabs } = await cmd('list_tabs')
    assertEq(tabs, [], 'S4 close_session 后 tab 列表为空')
  }

  const scenarios = [
    ['1 打开主页并枚举', s1],
    ['2 find_tab 切换当前 tab', s2],
    ['3 close_tab 关当前 tab', s3],
    ['4 close_session 收尾', s4],
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
