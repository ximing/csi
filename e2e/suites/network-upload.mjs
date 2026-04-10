// network-upload suite（叙述版见 e2e/cases/network-upload.md）：network / upload
import { writeFile } from 'node:fs/promises'
import { cmd, evaluateJS } from '../lib/bridge.mjs'
import { openPage } from '../lib/env.mjs'

const MAIN = 'http://127.0.0.1:8931/'
const FIXTURE = new URL('../artifacts/upload-me.txt', import.meta.url).pathname

export default async function run({ assertEq }) {
  await openPage(MAIN)

  async function s1() {
    await cmd('network', { cmd: 'start' })
    await cmd('click', { selector: '#fetch-btn' })
    const w = await cmd('wait', { text: 'hello', timeout_ms: 5000 })
    if (!w.success) throw new Error('S1 等 fetch 结果超时')
    assertEq(
      await evaluateJS('return document.getElementById("fetch-result").textContent'),
      '{"hello":"csi","seq":[1,2,3]}',
      'S1 页面回显',
    )
    const { requests } = await cmd('network', { cmd: 'list', filter: 'data.json' })
    const hit = requests.find((r) => r.url.endsWith('/api/data.json'))
    if (!hit) throw new Error(`S1 network 未抓到 data.json: ${JSON.stringify(requests)}`)
    assertEq({ method: hit.method, status: hit.status }, { method: 'GET', status: 200 }, 'S1 请求记录')
    await cmd('network', { cmd: 'stop' })
  }

  async function s2() {
    await writeFile(FIXTURE, 'csi e2e upload fixture\n')
    const r = await cmd('upload', { selector: '#file-input', files: [FIXTURE] })
    assertEq(r.fileCount, 1, 'S2 upload 文件数')
    const echo = await evaluateJS('return document.getElementById("upload-result").textContent')
    if (!echo.startsWith('已选择: upload-me.txt (')) throw new Error(`S2 回显异常: ${echo}`)
  }

  const scenarios = [
    ['1 network 抓到 fetch', s1],
    ['2 upload 设置文件并回显', s2],
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
