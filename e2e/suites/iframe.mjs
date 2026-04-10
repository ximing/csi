// iframe suite（叙述版见 e2e/cases/iframe.md）：
// list_frames / snapshot（frame 参数进同域帧）/ click·fill·evaluate（frame 参数）
// 偏离说明：case S2 手测用「对 iframe @e 再 snapshot」，suite 禁用 @e，
// 改用等价的 frame= URL 子串（技能文档允许的正式进框方式之一）。
import { cmd } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const FRAMES = 'http://127.0.0.1:8931/frames.html'
const SAME = '8931/frame.html'
const CROSS = '8932/frame.html'

export default async function run({ assertEq }) {
  await openPage(FRAMES)

  async function s1() {
    const { frames } = await cmd('list_frames')
    const same = frames.find((f) => f.name === 'same-frame')
    const cross = frames.find((f) => f.name === 'cross-frame')
    if (!same || !cross) throw new Error(`S1 帧不全: ${JSON.stringify(frames)}`)
    assertEq({ url: same.url, isolated: same.isolated }, {
      url: 'http://127.0.0.1:8931/frame.html',
      isolated: false,
    }, 'S1 同域帧')
    assertEq({ url: cross.url, isolated: cross.isolated }, {
      url: 'http://127.0.0.1:8932/frame.html',
      isolated: true,
    }, 'S1 跨域帧')
  }

  async function s2() {
    const r = await cmd('snapshot', { frame: SAME, mode: 'interactive' })
    assertEq(r.url, 'http://127.0.0.1:8931/frame.html', 'S2 帧内 url')
    for (const needle of ['textbox "帧内输入"', 'button "帧内按钮"', '[ref=@e']) {
      if (!r.tree.includes(needle)) throw new Error(`S2 帧内树缺 ${needle}`)
    }
  }

  async function s3() {
    await cmd('fill', { selector: '#frame-input', value: '帧内abc', frame: SAME })
    await cmd('click', { selector: '#frame-btn', frame: SAME })
    // 偏离说明：bridge.evaluateJS 不带 frame，帧内 evaluate 直接走 cmd
    const flash = await cmd('evaluate', {
      code: 'document.getElementById("frame-flash").textContent',
      frame: SAME,
    })
    assertEq(flash.value, '帧内收到: 帧内abc', 'S3 帧内交互回显')
  }

  async function s4() {
    let err = ''
    try {
      await cmd('evaluate', { code: '1+1', frame: CROSS })
    } catch (e) {
      err = e.message
    }
    if (!err.includes('cross-origin')) throw new Error(`S4 跨域报错不含 cross-origin: ${err || '(无错误，意外成功)'}`)
  }

  const scenarios = [
    ['1 list_frames 列出两个帧', s1],
    ['2 snapshot 进同域帧', s2],
    ['3 frame 参数帧内交互', s3],
    ['4 跨域帧报人话', s4],
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
