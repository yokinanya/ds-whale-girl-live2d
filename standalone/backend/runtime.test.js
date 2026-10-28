import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createRuntime } from './runtime.js'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const close = server => new Promise(resolve => server.close(resolve))
test('弹幕经过 WebSocket、调度器和模型服务到达舞台事件', async () => {
  const relay = http.createServer()
  const sockets = new WebSocketServer({ server: relay })
  const model = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions')
    req.resume()
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: '你好！', motion: 'splash' }) } }] }))
  })
  await Promise.all([listen(relay), listen(model)])
  let resolveEvent
  const output = new Promise(resolve => { resolveEvent = resolve })
  const runtime = createRuntime({ broadcast: resolveEvent, onStatus() {} })
  sockets.on('connection', socket => socket.on('message', raw => {
    if (JSON.parse(raw).cmd === 1) socket.send(JSON.stringify({ cmd: 2, data: ['', 123, '观众', 0, '你好', 0, false, 0, false, false, 0, 'id', '', 0, null, null, 'u1'] }))
  }))
  try {
    runtime.start({ blivechatUrl: `http://127.0.0.1:${relay.address().port}`, roomId: '42', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'demo', prompt: '友善' }, 'fake-key')
    const event = await Promise.race([output, new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 2000))])
    assert.deepEqual(event, { type: 'performance', text: '你好！', motion: 'splash' })
  } finally { runtime.stop(); sockets.close(); await Promise.all([close(relay), close(model)]) }
})

const configFor = (relay, model) => ({ blivechatUrl: `http://127.0.0.1:${relay.address().port}`,
  roomId: '42', baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'demo', prompt: '友善' })
const textPacket = (uid, text) => JSON.stringify({ cmd: 2, data: ['', 123, '观众', 0, text, 0, false, 0, false, false, 0, 'id', '', 0, null, null, uid] })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async condition => {
  const deadline = Date.now() + 3000
  while (!condition()) { if (Date.now() > deadline) throw new Error('等待超时'); await delay(5) }
}

test('配置队列及状态统计，停止后忽略模型异步结果', async () => {
  let reply, requestText
  const relay = http.createServer(), sockets = new WebSocketServer({ server: relay })
  const model = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requestText = JSON.parse(body).messages[1].content
    reply = () => res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"迟到","motion":null}' } }] }))
  })
  await Promise.all([listen(relay), listen(model)])
  let socket
  sockets.on('connection', ws => { socket = ws })
  const output = [], statuses = []
  const runtime = createRuntime({ broadcast: event => output.push(event), onStatus: (...args) => statuses.push(args) })
  try {
    runtime.start({ ...configFor(relay, model), queueSize: 1, ttlSeconds: 0.05, cooldownSeconds: 0, intervalSeconds: 0 }, 'fake')
    await until(() => runtime.getStatus().connection === 'connected')
    socket.send(textPacket(0, '  首条  '))
    await until(() => reply)
    assert.equal(requestText, '首条')
    socket.send(textPacket('a', '排队'))
    socket.send(textPacket('a', '排队'))
    socket.send(textPacket('b', '满了'))
    socket.send(textPacket('b', '   '))
    await until(() => runtime.getStatus().skipped.invalid === 1)
    assert.deepEqual(runtime.getStatus().skipped, { duplicate: 1, full: 1, expired: 0, invalid: 1 })
    await delay(60)
    assert.equal(runtime.getStatus().skipped.expired, 1)
    assert.equal(runtime.getStatus().queueSize, 0)
    assert.ok(statuses.every(([message, status]) => typeof message === 'string' && typeof status === 'object'))
    runtime.stop()
    reply()
    await delay(50)
    assert.deepEqual(output, [])
    assert.equal(runtime.getStatus().connection, 'stopped')
  } finally { runtime.stop(); sockets.close(); await Promise.all([close(relay), close(model)]) }
})

test('模型回复之间以及手动气泡之后至少间隔五秒，等待中的回复可取消', async () => {
  const relay = http.createServer(), sockets = new WebSocketServer({ server: relay })
  let requests = 0
  const model = http.createServer((req, res) => {
    req.resume(); requests++
    res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"回复","motion":null}' } }] }))
  })
  await Promise.all([listen(relay), listen(model)])
  let socket
  sockets.on('connection', ws => { socket = ws })
  const output = []
  const runtime = createRuntime({ broadcast: event => output.push({ event, time: Date.now() }) })
  try {
    runtime.start({ ...configFor(relay, model), intervalSeconds: 0, cooldownSeconds: 0 }, 'fake')
    await until(() => runtime.getStatus().connection === 'connected')
    runtime.perform({ text: '手动', motion: null })
    socket.send(textPacket('a', '第一条'))
    await until(() => requests === 1)
    await delay(100)
    assert.equal(output.length, 1)
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(check); reject(new Error('等待气泡超时')) }, 6000)
      const check = setInterval(() => { if (output.length === 2) { clearInterval(check); clearTimeout(timeout); resolve() } }, 10)
    })
    assert.ok(output[1].time - output[0].time >= 5000)
    socket.send(textPacket('b', '第二条'))
    await until(() => requests === 2)
    runtime.stop()
    await delay(100)
    assert.equal(output.length, 2)
  } finally { runtime.stop(); sockets.close(); await Promise.all([close(relay), close(model)]) }
})

test('拒绝无效调度参数而不停止当前运行', () => {
  const runtime = createRuntime({ broadcast() {} })
  const config = { blivechatUrl: 'http://localhost:1234', roomId: '42', baseUrl: 'http://localhost:1234', model: 'm', prompt: '' }
  for (const override of [{ queueSize: 0 }, { ttlSeconds: 0 }, { cooldownSeconds: -1 }, { intervalSeconds: NaN }, { intervalSeconds: '2' }]) {
    assert.throws(() => runtime.start({ ...config, ...override }, 'fake'), TypeError)
  }
  assert.equal(runtime.getStatus().running, false)
})

test('固定间隔和用户冷却控制模型请求，连接异常保留状态', async () => {
  const relay = http.createServer(), sockets = new WebSocketServer({ server: relay })
  const requests = []
  const model = http.createServer((req, res) => {
    req.resume(); requests.push(Date.now())
    res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"回复","motion":null}' } }] }))
  })
  await Promise.all([listen(relay), listen(model)])
  let socket
  sockets.on('connection', ws => { socket = ws })
  const runtime = createRuntime({ broadcast() {} })
  try {
    runtime.start({ ...configFor(relay, model), intervalSeconds: 0.12, cooldownSeconds: 0.2 }, 'fake')
    await until(() => runtime.getStatus().connection === 'connected')
    socket.send(textPacket('a', '一'))
    await until(() => requests.length === 1)
    socket.send(textPacket('a', '二'))
    socket.send(textPacket('b', '三'))
    await until(() => requests.length === 2)
    assert.ok(requests[1] - requests[0] >= 110)
    socket.send(JSON.stringify({ cmd: 8, data: { msg: '房间错误' } }))
    await until(() => runtime.getStatus().connection === 'fatal')
    assert.equal(runtime.getStatus().error, '上游返回错误')
  } finally { runtime.stop(); sockets.close(); await Promise.all([close(relay), close(model)]) }
})

test('重启后旧模型结果不会发送或改变新状态', async () => {
  const relay = http.createServer(), sockets = new WebSocketServer({ server: relay })
  let finishOld, count = 0
  const model = http.createServer((req, res) => {
    req.resume(); count++
    const finish = () => res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"回复","motion":null}' } }] }))
    if (count === 1) finishOld = finish
    else finish()
  })
  await Promise.all([listen(relay), listen(model)])
  const connections = []
  sockets.on('connection', ws => connections.push(ws))
  const output = []
  const runtime = createRuntime({ broadcast: event => output.push(event) })
  try {
    const config = configFor(relay, model)
    runtime.start(config, 'fake')
    await until(() => runtime.getStatus().connection === 'connected')
    connections[0].send(textPacket('a', '旧消息'))
    await until(() => finishOld)
    runtime.start(config, 'fake')
    await until(() => connections.length === 2 && runtime.getStatus().connection === 'connected')
    finishOld()
    await delay(50)
    assert.deepEqual(output, [])
    assert.equal(runtime.getStatus().busy, false)
    connections[1].send(textPacket('b', '新消息'))
    await until(() => output.length === 1)
  } finally { runtime.stop(); sockets.close(); await Promise.all([close(relay), close(model)]) }
})
