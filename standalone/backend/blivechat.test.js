import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { BlivechatClient, parseBlivechatText } from './blivechat.js'

class FakeSocket extends EventTarget {
  static instances = []
  constructor(url) {
    super()
    this.url = url
    this.sent = []
    this.closed = false
    FakeSocket.instances.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; this.dispatchEvent(new Event('close')) }
  open() { this.dispatchEvent(new Event('open')) }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data })) }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const options = { baseUrl: 'http://localhost:12450', roomId: 42, WebSocket: FakeSocket,
  heartbeatTimeout: 100, reconnectDelay: 10, maxReconnectDelay: 20 }
const lastSocket = () => FakeSocket.instances.at(-1)

test('joins on open and acknowledges binary and text heartbeats', () => {
  const statuses = []
  const client = new BlivechatClient({ ...options, onStatus: status => statuses.push(status.state) })
  client.start()
  const socket = lastSocket()
  assert.equal(socket.url, 'ws://localhost:12450/api/chat')
  socket.open()
  assert.deepEqual(socket.sent[0], { cmd: 1, data: { roomKey: { type: 1, value: 42 }, config: { autoTranslate: false } } })
  socket.receive(Buffer.from('{"cmd":0,"data":{}}'))
  socket.receive('{"cmd":0,"data":{}}')
  assert.deepEqual(socket.sent.slice(1), [{ cmd: 0 }, { cmd: 0 }])
  client.stop()
  assert.deepEqual(statuses, ['connecting', 'connected', 'stopped'])
  assert.equal(socket.closed, true)
})

test('parses text and forwards other commands; invalid packets report errors', () => {
  const messages = [], events = [], errors = []
  const client = new BlivechatClient({ ...options, onMessage: m => messages.push(m), onEvent: e => events.push(e), onError: e => errors.push(e) })
  client.start()
  const socket = lastSocket()
  socket.open()
  const data = ['avatar', 123, 'name', 1, 'hello', 2, 1, 3, 0, 1, 4, 'id', 'translated', 1, ['emote'], null, 'uid', 'medal', 1]
  assert.deepEqual(parseBlivechatText(data), { avatarUrl: 'avatar', timestamp: 123, authorName: 'name', authorType: 1,
    content: 'hello', privilegeType: 2, isGiftDanmaku: true, authorLevel: 3, isNewbie: false,
    isMobileVerified: true, medalLevel: 4, id: 'id', translation: 'translated', emoticon: 'emote',
    uid: 'uid', medalName: 'medal', isMirror: true })
  data[6] = 0
  data[13] = 0
  socket.receive(JSON.stringify({ cmd: 2, data }))
  assert.equal(messages[0].content, 'hello')
  socket.receive('{"cmd":3,"data":{"gift":"x"}}')
  socket.receive('invalid')
  socket.receive('{"cmd":2,"data":{}}')
  assert.deepEqual(events, [{ cmd: 3, data: { gift: 'x' } }])
  assert.equal(errors.length, 2)
  assert.throws(() => parseBlivechatText(null), TypeError)
  client.stop()
})

test('filters upstream gift, emoticon and system messages without suppressing users', () => {
  const messages = [], events = []
  const client = new BlivechatClient({ ...options, onMessage: m => messages.push(m), onEvent: e => events.push(e) })
  client.start()
  const socket = lastSocket()
  socket.open()
  const data = ['', 123, 'viewer', 2, 'hello', 0, 0, 1, 0, 1, 0, 'id', '', 0, [], [], 'uid', '', 0]
  const send = changes => {
    const copy = [...data]
    for (const [index, value] of Object.entries(changes)) copy[index] = value
    socket.receive(JSON.stringify({ cmd: 2, data: copy }))
  }
  send({ 6: 1 })
  send({ 4: '老板大气！点点红包抽礼物', 6: 0 })
  send({ 13: 1, 14: ['https://example.com/emote'] })
  send({ 4: '  ' })
  send({ 2: 'blivechat', 4: 'Translation is not allowed in this room. Please download to use translation', 16: '' })
  send({})
  send({ 2: 'blivechat', 4: 'hello', 16: 'real-uid' })
  socket.receive('{"cmd":3,"data":{"giftName":"x"}}')
  assert.deepEqual(messages.map(m => [m.authorName, m.content]), [['viewer', '  '], ['viewer', 'hello'], ['blivechat', 'hello']])
  assert.deepEqual(events, [{ cmd: 3, data: { giftName: 'x' } }])
  client.stop()
})

test('heartbeat timeout reconnects, rejoins, ignores old socket, and stop cancels retry', async () => {
  const statuses = [], errors = []
  const client = new BlivechatClient({ ...options, heartbeatTimeout: 20, onStatus: s => statuses.push(s.state), onError: e => errors.push(e) })
  client.start()
  const first = lastSocket()
  first.open()
  await wait(45)
  const second = lastSocket()
  assert.notEqual(first, second)
  assert.equal(first.closed, true)
  assert.match(errors[0].message, /heartbeat/)
  first.receive('{"cmd":0}')
  second.open()
  assert.equal(second.sent[0].cmd, 1)
  second.close()
  client.stop()
  const count = FakeSocket.instances.length
  await wait(30)
  assert.equal(FakeSocket.instances.length, count)
  assert.ok(statuses.includes('reconnecting'))
  assert.equal(client.state, 'stopped')
})

test('fatal stops retries; factory errors retry; auth code and options are forwarded', async () => {
  let calls = 0
  const errors = [], statuses = []
  const client = new BlivechatClient({ ...options, baseUrl: 'https://example.com/prefix/',
    roomKey: { type: 2, value: 'secret' }, autoTranslate: true,
    createWebSocket: url => { if (++calls === 1) throw new Error('failed'); return new FakeSocket(url) },
    onError: error => errors.push(error), onStatus: s => statuses.push(s) })
  client.start()
  await wait(20)
  const socket = lastSocket()
  assert.equal(socket.url, 'wss://example.com/prefix/api/chat')
  socket.open()
  assert.deepEqual(socket.sent[0].data, { roomKey: { type: 2, value: 'secret' }, config: { autoTranslate: true } })
  socket.receive('{"cmd":8,"data":{"type":1,"msg":"bad"}}')
  assert.equal(client.state, 'fatal')
  assert.deepEqual(statuses.at(-1).error, { type: 1, msg: 'bad' })
  assert.equal(errors.length, 1)
  await wait(30)
  assert.equal(calls, 2)
  client.stop()
})

test('exchanges upstream binary frames over a real WebSocket', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const received = [], messages = []
  const client = new BlivechatClient({ ...options, WebSocket,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    onMessage: message => messages.push(message), heartbeatTimeout: 1000 })
  t.after(() => { client.stop(); server.close() })
  const connected = once(server, 'connection')
  client.start()
  const [peer] = await connected
  peer.on('message', data => received.push(JSON.parse(data.toString())))
  await once(peer, 'message')
  assert.deepEqual(received[0], { cmd: 1, data: { roomKey: { type: 1, value: 42 }, config: { autoTranslate: false } } })
  const ack = once(peer, 'message')
  peer.send(Buffer.from('{"cmd":0,"data":{}}'))
  await ack
  assert.deepEqual(received[1], { cmd: 0 })
  const data = ['', 123, 'viewer', 0, 'hello', 0, 0, 1, 0, 1, 0, 'id', '', 0, [], [], 'uid', '', 0]
  peer.send(Buffer.from(JSON.stringify({ cmd: 2, data })))
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 500
    const check = () => messages.length ? resolve() : Date.now() > deadline ? reject(new Error('message timeout')) : setTimeout(check, 5)
    check()
  })
  assert.equal(messages[0].content, 'hello')
})

test('rejects invalid configuration', () => {
  assert.throws(() => new BlivechatClient({ ...options, roomId: '42' }), TypeError)
  assert.throws(() => new BlivechatClient({ ...options, baseUrl: 'ftp://example.com' }), TypeError)
  assert.throws(() => new BlivechatClient({ ...options, baseUrl: 'http://user:pass@example.com' }), TypeError)
  assert.throws(() => new BlivechatClient({ ...options, WebSocket: null }), TypeError)
})
