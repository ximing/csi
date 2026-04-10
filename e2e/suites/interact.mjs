// interact suite（叙述版见 e2e/cases/interact.md）：
// snapshot / click / fill / key_type / send_keys / mouse_click / hover / scroll
import { cmd, evaluateJS } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const MAIN = 'http://127.0.0.1:8931/'

export default async function run({ assertEq }) {
  await openPage(MAIN)

  async function s1() {
    const { tree } = await cmd('snapshot', { mode: 'interactive' })
    for (const needle of ['textbox "用户名"', 'button "登录"', '[ref=@e']) {
      if (!tree.includes(needle)) throw new Error(`S1 snapshot 缺 ${needle}`)
    }
  }

  async function s2() {
    await cmd('fill', { selector: '#username', value: 'e2e用户' })
    await cmd('fill', { selector: '#password', value: 'pass123' })
    await cmd('click', { selector: '#login-btn' })
    assertEq(
      await evaluateJS('return document.getElementById("login-flash").textContent'),
      '登录成功: e2e用户 / pass123 / remember=false / role=user',
      'S2 提交回显',
    )
  }

  async function s3() {
    await cmd('click', { selector: '#remember' })
    // 已验证：合成 click 点 <option> 不改 select 值，select 只能 evaluate 设值 + change
    await evaluateJS(`
      const s = document.getElementById('role')
      s.value = 'admin'
      s.dispatchEvent(new Event('change', { bubbles: true }))
      return s.value`)
    await cmd('click', { selector: '#login-btn' })
    assertEq(
      await evaluateJS('return document.getElementById("login-flash").textContent'),
      '登录成功: e2e用户 / pass123 / remember=true / role=admin',
      'S3 勾选+改角色后回显',
    )
  }

  async function s4() {
    await cmd('fill', { selector: '#username', value: '' })
    // click 工具是 DOM 级 el.click()，不移动焦点；key_type 前先显式 focus
    await evaluateJS(`document.getElementById('username').focus(); return true`)
    await cmd('key_type', { text: 'ab' })
    await cmd('send_keys', { keys: 'Backspace' })
    assertEq(
      await evaluateJS('return document.getElementById("username").value'),
      'a',
      'S4 key_type + Backspace',
    )
  }

  async function s5() {
    await cmd('mouse_click', { selector: '#password' })
    assertEq(
      await evaluateJS('return document.activeElement.id'),
      'password',
      'S5 mouse_click 移动焦点到密码框',
    )
  }

  async function s6() {
    await cmd('hover', { selector: '#hover-trigger' })
    assertEq(
      await evaluateJS('return document.getElementById("hover-body").offsetParent !== null'),
      true,
      'S6 hover 展开菜单',
    )
  }

  async function s7() {
    await cmd('scroll', { direction: 'down', amount: 2000 })
    const r = await evaluateJS(`return {
      top: Math.round(document.getElementById('scroll-sentinel').getBoundingClientRect().top),
      ih: innerHeight,
    }`)
    if (!(r.top < r.ih)) throw new Error(`S7 sentinel 未进视口: ${JSON.stringify(r)}`)
  }

  const scenarios = [
    ['1 snapshot 出树带引用', s1],
    ['2 fill+click 提交', s2],
    ['3 checkbox 与 select', s3],
    ['4 key_type 与 send_keys', s4],
    ['5 mouse_click 聚焦', s5],
    ['6 hover 展开菜单', s6],
    ['7 scroll 到底部', s7],
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
