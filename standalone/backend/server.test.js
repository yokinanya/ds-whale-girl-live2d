import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOverlayServer } from './server.js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
test('浏览器源需要令牌，事件流只推送新事件', async () => {
  const server = await createOverlayServer({ stageDir: path.join(root, 'standalone/stage'), assetsDir: path.join(root, 'assets') })
  try {
    const url = new URL(server.overlayUrl)
    assert.equal((await fetch(`${url.origin}/events`)).status, 403)
    assert.equal((await fetch(`${url.origin}/overlay`)).status, 403)
    assert.equal((await fetch(`${url.origin}/assets/model/c_0120.model3.json`)).status, 200)
    const response = await fetch(`${url.origin}/events?token=${url.searchParams.get('token')}`)
    const reader = response.body.getReader()
    await reader.read()
    server.broadcast({ type: 'performance', text: '测试' })
    const chunk = await reader.read()
    assert.match(new TextDecoder().decode(chunk.value), /测试/)
    await reader.cancel()
  } finally { await server.close() }
})
