// 零依赖静态服务器：同一目录起两个端口 = 两个源（同源/跨源 iframe 都有的测）。
// 同时绑 IPv4/IPv6 回环，让 localhost 与 127.0.0.1 成为两个 host（find_tab 按 host 匹配，
// 需要同端口不同 host 的两个 tab 来测）。
// 用法: node e2e/testbed/serve.mjs   （8931 = 主源，8932 = 跨源）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const ROOT = new URL('.', import.meta.url).pathname
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

function handler(req, res) {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (path.includes('..')) { res.writeHead(403); res.end(); return }
  const file = join(ROOT, path === '/' ? 'index.html' : path)
  readFile(file)
    .then((buf) => {
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(buf)
    })
    .catch(() => { res.writeHead(404); res.end('not found') })
}

for (const port of [8931, 8932]) {
  for (const host of ['127.0.0.1', '::1']) {
    createServer(handler).listen(port, host, () => {
      console.log(`testbed: http://${host.includes(':') ? `[${host}]` : host}:${port}/`)
    })
  }
}
