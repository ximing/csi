// 通用环境助手：daemon 可达性、开页清场、轮询等待、证据截图。
// 刻意不含任何被测 app 的特定逻辑——app 的 URL/启动方式由 cases/*.md 头部声明。
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { bringToFront, cmd, evaluateJS, getSession, setSession } from './bridge.mjs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// daemon 可达性；不可达时尝试 csi start（幂等），10s 仍不通则给出明确指引
export async function ensureDaemon() {
  try { await cmd('list_tabs'); return } catch {}
  const bin = process.platform === 'win32'
    ? `${homedir()}\\.csi\\bin\\csi.exe`
    : `${homedir()}/.csi/bin/csi`
  try { spawn(bin, ['start'], { stdio: 'ignore', detached: true }).unref() } catch {}
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    try { await cmd('list_tabs'); return } catch {}
  }
  throw new Error('csi daemon 不可达（先运行 csi start，并确认 Chrome 扩展已连接）')
}

// 打开被测页面：先清掉本 e2e session 的残留 tab（只影响 e2e 自己的分组，
// 不动用户其它 tab），再 navigate。daemon 侧 tab 绑定可能腐坏（浏览器侧已关、
// daemon 仍记旧 id → navigate 报错）→ 换新 session 重试一次。
export async function openPage(url, { groupTitle = 'e2e 回归' } = {}) {
  await ensureDaemon()
  try { await cmd('close_session') } catch {}
  try {
    await cmd('navigate', { url, newTab: true, group_title: groupTitle })
  } catch (e) {
    setSession(`${getSession()}-${Date.now() % 100000}`)
    console.warn(`navigate 失败（${e.message}），换新 session ${getSession()} 重试`)
    await cmd('navigate', { url, newTab: true, group_title: groupTitle })
  }
  await bringToFront()
  // 已验证：Chrome 窗口不在 OS 前台时 tab visibilityState=hidden，trusted 键事件
  // （send_keys）会被丢弃、mouse_click 不移动焦点。开焦点仿真让页面行为与可见一致，
  // 与 OS 窗口状态解耦（Puppeteer 同款做法）。
  await cmd('cdp', { method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } })
}

// 轮询页面条件（页面内防抖/定时器延迟不可靠，固定 sleep 会抖动）
export async function pollUntil(predCode, label, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    if (await evaluateJS(`return !!(${predCode})`)) return
    if (Date.now() - t0 > timeoutMs) throw new Error(`超时等待: ${label}`)
    await sleep(400)
  }
}

// 证据截图：daemon 落盘，path 按字面写入且父目录自建——daemon 的 cwd 与 runner
// 无关，所以这里从本文件位置推导绝对路径。relPath 相对 e2e/ 目录（如 'artifacts/login-s2.png'）
export function shot(relPath) {
  const abs = new URL(`../${relPath}`, import.meta.url).pathname
  return cmd('screenshot', { path: abs })
}
