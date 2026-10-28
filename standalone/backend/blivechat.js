/**
 * blivechat relay adapter (dev and v1.10.4): /api/chat, not the plugin API.
 * Start an external blivechat server first; no blivechat plugin is required.
 * Electron 33's Node runtime may not provide WebSocket: install `ws` as a
 * production dependency in the consuming app and pass its constructor:
 *
 *   import WebSocket from 'ws'
 *   import { BlivechatClient } from './blivechat.js'
 *   const client = new BlivechatClient({ baseUrl: 'http://127.0.0.1:12450',
 *     roomId: 123, WebSocket, onMessage: console.log, onStatus: console.log })
 *   client.start() // client.stop() when done
 *
 * Alternatively pass roomKey: {type: 1, value: roomId} or {type: 2, value:
 * authCode}, and/or createWebSocket(url). Status is {state, ...details};
 * connected means join was sent, not that upstream confirmed room admission.
 * onMessage excludes emoticons, gift danmaku, and the upstream blivechat
 * system notice; blank text is forwarded for downstream validation. onEvent receives
 * other upstream commands as {cmd, data}. onError receives protocol/transport errors.
 * Only heartbeat packets refresh the 15s receive deadline, as in upstream.
 * Sources: xfgryujk/blivechat dev and v1.10.4, api/chat.py and
 * frontend/src/api/chat/ChatClientRelay.js.
 */
const HEARTBEAT = 0
const JOIN_ROOM = 1
const ADD_TEXT = 2
const FATAL_ERROR = 8
// Matches the upstream frontend's open-platform gift-danmaku fallback.
const GIFT_DANMAKU_CONTENTS = new Set([
  '老板大气！点点红包抽礼物', '老板大气！点点红包抽礼物！', '点点红包，关注主播抽礼物～',
  '喜欢主播加关注，点点红包抽礼物', '红包抽礼物，开启今日好运！', '中奖喷雾！中奖喷雾！',
  '前方高能预警，注意这不是演习', '我从未见过如此厚颜无耻之人', '那万一赢了呢',
  '你们城里人真会玩', '左舷弹幕太薄了', '要优雅，不要污', '我选择狗带',
  '可爱即正义~~', '糟了，是心动的感觉！', '这个直播间已经被我们承包了！',
  '妈妈问我为什么跪着看直播 w(ﾟДﾟ)w', '你们对力量一无所知~(￣▽￣)~',
])
const TRANSLATION_NOTICE = 'Translation is not allowed in this room. Please download to use translation'

export function parseBlivechatText(data) {
  if (!Array.isArray(data) || typeof data[4] !== 'string') {
    throw new TypeError('Invalid blivechat text message')
  }
  return {
    avatarUrl: data[0], timestamp: data[1], authorName: data[2],
    authorType: data[3], content: data[4], privilegeType: data[5],
    isGiftDanmaku: Boolean(data[6]) || GIFT_DANMAKU_CONTENTS.has(data[4]), authorLevel: data[7],
    isNewbie: Boolean(data[8]), isMobileVerified: Boolean(data[9]),
    medalLevel: data[10], id: data[11], translation: data[12],
    emoticon: data[13] === 1 ? data[14]?.[0] ?? null : null,
    uid: data[16], medalName: data[17], isMirror: Boolean(data[18]),
  }
}

export class BlivechatClient {
  constructor({ baseUrl, roomId, roomKey, WebSocket: Socket = globalThis.WebSocket,
    createWebSocket, autoTranslate = false, onMessage = () => {},
    onEvent = () => {}, onStatus = () => {}, onError = () => {},
    heartbeatTimeout = 15000, reconnectDelay = 1000, maxReconnectDelay = 20000 } = {}) {
    const url = new URL(baseUrl)
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new TypeError('baseUrl must be an HTTP(S) or WS(S) base URL without credentials, query or fragment')
    }
    url.protocol = url.protocol === 'http:' ? 'ws:' : url.protocol === 'https:' ? 'wss:' : url.protocol
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/chat`
    this.url = url.href
    const key = roomKey ?? { type: 1, value: roomId }
    if (!key || !((key.type === 1 && Number.isSafeInteger(key.value) && key.value > 0) ||
      (key.type === 2 && typeof key.value === 'string' && key.value.length > 0))) {
      throw new TypeError('roomKey must contain a positive integer room ID or a nonempty auth code')
    }
    if (!createWebSocket && typeof Socket !== 'function') throw new TypeError('Provide a WebSocket constructor or createWebSocket factory')
    if (![heartbeatTimeout, reconnectDelay, maxReconnectDelay].every(n => Number.isFinite(n) && n > 0)) {
      throw new TypeError('Timeouts and reconnect delays must be positive numbers')
    }
    this.roomKey = { type: key.type, value: key.value }
    this.factory = createWebSocket ?? (url => new Socket(url))
    Object.assign(this, { autoTranslate, onMessage, onEvent, onStatus, onError,
      heartbeatTimeout, reconnectDelay, maxReconnectDelay })
    this.state = 'stopped'
    this.running = false
    this.socket = null
    this.timer = null
    this.reconnectTimer = null
    this.attempt = 0
  }

  setStatus(state, details = {}) {
    this.state = state
    this.onStatus({ state, ...details })
  }

  start() {
    if (this.running) return
    this.running = true
    this.attempt = 0
    this.connect()
  }

  stop() {
    this.running = false
    clearTimeout(this.timer)
    clearTimeout(this.reconnectTimer)
    this.timer = this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    if (socket) socket.close()
    if (this.state !== 'stopped') this.setStatus('stopped')
  }

  connect() {
    if (!this.running) return
    this.setStatus('connecting')
    if (!this.running) return
    let socket
    try {
      socket = this.factory(this.url)
      this.socket = socket
      socket.addEventListener('open', () => this.open(socket))
      socket.addEventListener('message', event => this.message(socket, event.data))
      socket.addEventListener('error', event => {
        if (this.socket === socket) this.onError(event.error ?? new Error('WebSocket error'))
      })
      socket.addEventListener('close', () => this.disconnected(socket))
      this.armTimeout(socket)
    } catch (error) {
      this.socket = null
      clearTimeout(this.timer)
      this.timer = null
      if (socket) socket.close()
      this.onError(error)
      this.scheduleReconnect()
    }
  }

  open(socket) {
    if (!this.running || this.socket !== socket) return
    try {
      socket.send(JSON.stringify({ cmd: JOIN_ROOM, data: {
        roomKey: this.roomKey, config: { autoTranslate: this.autoTranslate },
      } }))
      this.setStatus('connected')
      if (this.running && this.socket === socket) this.armTimeout(socket)
    } catch (error) {
      this.onError(error)
      this.disconnected(socket, true)
    }
  }

  armTimeout(socket) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      if (this.socket !== socket) return
      this.onError(new Error('blivechat heartbeat timed out'))
      this.disconnected(socket, true)
    }, this.heartbeatTimeout)
  }

  async message(socket, payload) {
    if (!this.running || this.socket !== socket) return
    let packet
    try {
      if (typeof Blob !== 'undefined' && payload instanceof Blob) payload = await payload.arrayBuffer()
      if (!this.running || this.socket !== socket) return
      if (typeof payload !== 'string') {
        if (payload instanceof ArrayBuffer) payload = new Uint8Array(payload)
        if (!ArrayBuffer.isView(payload)) throw new TypeError('Unsupported WebSocket payload')
        payload = new TextDecoder('utf-8', { fatal: true }).decode(payload)
      }
      packet = JSON.parse(payload)
      if (!packet || !Number.isInteger(packet.cmd)) throw new TypeError('Invalid blivechat command')
      if (packet.cmd === HEARTBEAT) {
        socket.send(JSON.stringify({ cmd: HEARTBEAT }))
        this.armTimeout(socket)
      } else if (packet.cmd === ADD_TEXT) {
        const message = parseBlivechatText(packet.data)
        if (packet.data[13] !== 1 && !message.isGiftDanmaku &&
          !(message.authorName === 'blivechat' && message.content === TRANSLATION_NOTICE && !message.uid)) {
          this.onMessage(message)
        }
      } else if (packet.cmd === FATAL_ERROR) {
        this.running = false
        clearTimeout(this.timer)
        this.timer = null
        this.socket = null
        socket.close()
        this.setStatus('fatal', { error: packet.data })
        return
      } else {
        this.onEvent(packet)
      }
      this.attempt = 0
    } catch (error) {
      this.onError(error)
    }
  }

  disconnected(socket, close = false) {
    if (this.socket !== socket) return
    this.socket = null
    clearTimeout(this.timer)
    this.timer = null
    if (close) socket.close()
    if (this.running) this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return
    const delay = Math.min(this.reconnectDelay * 2 ** Math.min(this.attempt++, 30), this.maxReconnectDelay)
    this.setStatus('reconnecting', { delay, attempt: this.attempt })
    if (!this.running) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }
}
