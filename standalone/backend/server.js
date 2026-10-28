import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.moc3': 'application/octet-stream' }

export async function createOverlayServer({ stageDir, assetsDir, port = 0 }) {
  const token = randomBytes(32).toString('hex')
  const clients = new Set()
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || ''
    if (!/^127\.0\.0\.1:\d+$/.test(host) || req.method !== 'GET') {
      res.writeHead(403).end(); return
    }
    const url = new URL(req.url, `http://${host}`)
    const supplied = Buffer.from(url.searchParams.get('token') || '')
    const expected = Buffer.from(token)
    const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected)
    if (url.pathname === '/events') {
      if (!authorized) { res.writeHead(403).end(); return }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' })
      res.write(': connected\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (url.pathname === '/overlay' && !authorized) { res.writeHead(403).end(); return }
    let root, relative
    if (url.pathname === '/overlay') { root = stageDir; relative = 'index.html' }
    else if (url.pathname.startsWith('/stage/')) { root = stageDir; relative = url.pathname.slice(7) }
    else if (url.pathname.startsWith('/assets/')) { root = assetsDir; relative = url.pathname.slice(8) }
    else { res.writeHead(404).end(); return }
    try {
      relative = decodeURIComponent(relative)
      const file = path.resolve(root, relative)
      if (!file.startsWith(path.resolve(root) + path.sep)) { res.writeHead(403).end(); return }
      const data = await readFile(file)
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
      res.end(data)
    } catch { res.writeHead(404).end() }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    overlayUrl: `${origin}/overlay?token=${token}`,
    broadcast(event) { const frame = `data: ${JSON.stringify(event)}\n\n`; for (const client of clients) client.write(frame) },
    async close() { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)) },
  }
}
