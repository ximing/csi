// capture suite（叙述版见 e2e/cases/capture.md）：screenshot（视口 + fullPage）/ save_as_pdf
import { readFile } from 'node:fs/promises'
import { cmd } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const MAIN = 'http://127.0.0.1:8931/'
const ART = (name) => new URL(`../artifacts/${name}`, import.meta.url).pathname

// PNG 头 8 字节魔数后紧跟 IHDR：宽/高各 4 字节大端，位于 offset 16/20
function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

export default async function run({ assertEq }) {
  await openPage(MAIN)

  async function s1() {
    const r = await cmd('screenshot', { path: ART('capture-viewport.png') })
    if (r.sizeBytes < 10 * 1024) throw new Error(`S1 截图过小: ${r.sizeBytes}`)
    const buf = await readFile(r.path)
    assertEq(buf.subarray(1, 4).toString(), 'PNG', 'S1 PNG 魔数')
  }

  async function s2() {
    const r = await cmd('screenshot', { path: ART('capture-full.png'), fullPage: true })
    const full = pngSize(await readFile(r.path))
    const view = pngSize(await readFile(ART('capture-viewport.png')))
    // 页面有 1500px 滚动区，fullPage 高度必须明显大于视口
    if (!(full.h > view.h + 500)) {
      throw new Error(`S2 fullPage 高度 ${full.h} 未明显大于视口 ${view.h}`)
    }
  }

  async function s3() {
    const r = await cmd('save_as_pdf', { path: ART('capture.pdf') })
    if (r.sizeBytes < 5 * 1024) throw new Error(`S3 PDF 过小: ${r.sizeBytes}`)
    const buf = await readFile(r.path)
    assertEq(buf.subarray(0, 4).toString(), '%PDF', 'S3 PDF 魔数')
  }

  const scenarios = [
    ['1 视口截图', s1],
    ['2 fullPage 截图', s2],
    ['3 save_as_pdf', s3],
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
