// e2e 回归 runner：node e2e/run.mjs [suite...]（默认跑 suites/ 下全部）
import { readdirSync } from 'node:fs'

// suite 按文件名自动发现，新增 suites/<name>.mjs 无需改这里
const suitesDir = new URL('./suites/', import.meta.url)
const suites = Object.fromEntries(
  readdirSync(suitesDir)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => [f.replace(/\.mjs$/, ''), f]),
)

// daemon evaluate 返回值经序列化后对象 key 序不稳定（实测按字母序），比较前须规范化
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export function assertEq(actual, expected, label) {
  const a = canon(actual)
  const e = canon(expected)
  if (a !== e) throw new Error(`${label}\n  expected: ${e}\n  actual:   ${a}`)
}

const only = process.argv.slice(2)
// 未知 suite 名立即报错退出（防静默 0/0 误判通过）
const unknown = only.filter((n) => !suites[n])
if (unknown.length) {
  console.error(`未知 suite: ${unknown.join(', ')}（可用: ${Object.keys(suites).join(', ')}）`)
  process.exit(1)
}
const names = only.length ? only : Object.keys(suites)
let pass = 0, fail = 0
for (const name of names) {
  const { default: run } = await import(new URL(`./suites/${suites[name]}`, import.meta.url))
  try {
    await run({ assertEq })
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}
console.log(`suites: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
