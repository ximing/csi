// csi daemon HTTP 封装：单 session 驱动浏览器。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const PORT = process.env.CSI_PORT || 10088
const DAEMON = `http://127.0.0.1:${PORT}/command`
// session 可变：navigate 命中腐坏 tab 绑定时换新 session 重试（见 env.mjs openPage）
let session = process.env.E2E_SESSION || `e2e-${basename(process.cwd())}`

export const getSession = () => session
export const setSession = (s) => { session = s }

// daemon 开了鉴权（协议 §2.7）时自动带 Bearer key；key 存在 ~/.csi/config.json。
// 首次调用时读一次；读不到视为未开鉴权（daemon 会忽略多余 header，无副作用）。
let cachedKey
function apiKey() {
  if (cachedKey !== undefined) return cachedKey
  try {
    cachedKey = JSON.parse(readFileSync(join(homedir(), '.csi', 'config.json'), 'utf8')).api_key || ''
  } catch {
    cachedKey = ''
  }
  return cachedKey
}

export async function cmd(action, args = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const key = apiKey()
  if (key) headers.Authorization = `Bearer ${key}`
  const res = await fetch(DAEMON, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, args, session }),
  })
  // csi 协议：成功失败都是 HTTP 200，错误是 body 里的字符串；唯一例外是
  // 鉴权未通过的 401——key 过期/写错时给出可行动的提示。
  if (res.status === 401) throw new Error(`${action} 失败: HTTP 401 unauthorized（daemon 已开启鉴权且 key 无效，检查 ~/.csi/config.json 的 api_key）`)
  const j = await res.json()
  if (!j.success) throw new Error(`${action} 失败: ${j.error}`)
  return j.data
}

// evaluate：自动包 async IIFE；返回值须可 JSON 序列化
export async function evaluateJS(code) {
  const data = await cmd('evaluate', { code: `(async()=>{${code}})()` })
  return data.value
}

export const bringToFront = () => cmd('cdp', { method: 'Page.bringToFront', params: {} })
