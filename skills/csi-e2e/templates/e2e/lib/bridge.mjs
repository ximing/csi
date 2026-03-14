// csi daemon HTTP 封装：单 session 驱动浏览器。
import { basename } from 'node:path'

const PORT = process.env.CSI_PORT || 10088
const DAEMON = `http://127.0.0.1:${PORT}/command`
// session 可变：navigate 命中腐坏 tab 绑定时换新 session 重试（见 env.mjs openPage）
let session = process.env.E2E_SESSION || `e2e-${basename(process.cwd())}`

export const getSession = () => session
export const setSession = (s) => { session = s }

export async function cmd(action, args = {}) {
  const res = await fetch(DAEMON, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session }),
  })
  const j = await res.json()
  // csi 协议：成功失败都是 HTTP 200，错误是 body 里的字符串
  if (!j.success) throw new Error(`${action} 失败: ${j.error}`)
  return j.data
}

// evaluate：自动包 async IIFE；返回值须可 JSON 序列化
export async function evaluateJS(code) {
  const data = await cmd('evaluate', { code: `(async()=>{${code}})()` })
  return data.value
}

export const bringToFront = () => cmd('cdp', { method: 'Page.bringToFront', params: {} })
