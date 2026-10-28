import WebSocket from 'ws'
import { BlivechatClient } from './blivechat.js'
import { createScheduler } from './scheduler.js'
import { createLlmClient } from './llm.js'

export const motions = ['idle', 'aidale', 'selfie', 'selfieQuick', 'ketchup', 'openLid', 'bubble', 'splash']
const BUBBLE_MS = 5000
const MAX_TIMEOUT = 2147483647

function schedulerOptions(config) {
  const options = {}
  if (config.queueSize !== undefined) {
    if (!Number.isSafeInteger(config.queueSize) || config.queueSize < 1) throw new TypeError('Invalid queueSize')
    options.maxQueue = config.queueSize
  }
  for (const [field, target, min] of [
    ['ttlSeconds', 'ttlMs', 1], ['cooldownSeconds', 'cooldownMs', 0], ['intervalSeconds', 'globalIntervalMs', 0],
  ]) {
    if (config[field] === undefined) continue
    const ms = config[field] * 1000
    if (typeof config[field] !== 'number' || !Number.isSafeInteger(ms) || ms < min || ms > MAX_TIMEOUT) throw new TypeError(`Invalid ${field}`)
    options[target] = ms
  }
  if (options.globalIntervalMs !== undefined) options.minGlobalIntervalMs = options.globalIntervalMs
  return options
}

// start config: queueSize (default 100), ttlSeconds (30), cooldownSeconds (3),
// intervalSeconds (2, adaptive when omitted; fixed when supplied). Durations accept
// millisecond precision. Model bubbles wait at least 5s after any performance.
// onStatus retains its string first argument; the second argument and getStatus()
// expose snapshots. A connection marked connected has sent the join, not confirmed admission.
export function createRuntime({ broadcast, onStatus = () => {}, expressions = [] }) {
  let client, scheduler, timer, generation = 0, busy = false, pending = null
  let lastBroadcast = -Infinity
  let state = { running: false, connection: 'stopped', error: null, busy: false,
    queueSize: 0, skipped: { duplicate: 0, full: 0, expired: 0, invalid: 0 } }
  function snapshot() {
    const stats = scheduler?.getStatus()
    return { ...state, busy, queueSize: stats?.queueSize ?? state.queueSize,
      skipped: { ...state.skipped, ...stats?.skipped } }
  }
  function notify(message) { onStatus(message, snapshot()) }
  function stop() {
    generation++
    clearTimeout(timer)
    timer = null
    if (scheduler) state = { ...snapshot(), queueSize: 0 }
    client?.stop()
    client = null
    scheduler = null
    busy = false
    pending = null
    state = { ...state, running: false, connection: 'stopped', busy: false }
    notify('已停止')
  }
  function start(config, apiKey, authCode = '') {
    if (typeof authCode !== 'string' || authCode.length > 256) throw new Error('直播身份码无效')
    authCode = authCode.trim()
    if ((!config.roomId && !authCode) || !config.model || !apiKey) throw new Error('请先设置房间号或直播身份码、模型和 API 密钥')
    const llm = createLlmClient({ baseUrl: config.baseUrl, apiKey, model: config.model, prompt: config.prompt, motions })
    const nextScheduler = createScheduler(schedulerOptions(config))
    const run = generation + 1
    const nextClient = new BlivechatClient({
      baseUrl: config.blivechatUrl, roomId: Number(config.roomId), ...(authCode ? { roomKey: { type: 2, value: authCode.trim() } } : {}), WebSocket,
      onStatus: status => {
        if (generation !== run) return
        state.connection = status.state
        if (status.error) state.error = '上游返回错误'
        else if (status.state === 'connected') state.error = null
        notify(`blivechat：${status.state}${status.error ? '（上游返回错误）' : ''}`)
      },
      onError: error => {
        if (generation !== run) return
        state.error = `blivechat 错误：${error.message}`
        notify(state.error)
      },
      onMessage: message => {
        if (generation !== run || !scheduler) return
        try {
          const text = typeof message.content === 'string' ? message.content.trim() : ''
          const user = message.uid != null && String(message.uid).trim() ? String(message.uid) : message.authorName
          const result = scheduler.enqueue({ userId: user, text })
          if (!result.accepted) notify(`弹幕已跳过：${result.reason}；队列 ${scheduler.size}`)
          else { notify(`弹幕已入队；队列 ${scheduler.size}`); pump() }
        } catch (error) {
          state.skipped.invalid++
          notify(`弹幕无效：${error.message}`)
        }
      },
    })
    stop()
    scheduler = nextScheduler
    client = nextClient
    state = { running: true, connection: 'stopped', error: null, busy: false,
      queueSize: 0, skipped: { duplicate: 0, full: 0, expired: 0, invalid: 0 } }
    function pump() {
      if (generation !== run || !scheduler) return
      clearTimeout(timer)
      timer = null
      if (pending) {
        const wait = Math.max(0, lastBroadcast + BUBBLE_MS - Date.now())
        if (wait) { timer = setTimeout(pump, wait); return }
        const result = pending
        pending = null
        lastBroadcast = Date.now()
        broadcast({ type: 'performance', ...result })
        if (generation !== run) return
        busy = false
        notify('回复已发送')
      }
      if (busy) return
      const next = scheduler.poll()
      if (!next.event) {
        if (next.expired) notify(`弹幕已过期：${next.expired}`)
        if (next.waitMs != null) timer = setTimeout(pump, Math.max(1, next.waitMs))
        return
      }
      busy = true
      notify(`处理中；队列 ${scheduler.size}，过期 ${next.expired}`)
      if (generation !== run) return
      llm.reply(next.event.text).then(result => {
        if (generation !== run) return
        pending = result
        pump()
      }, error => {
        if (generation !== run) return
        busy = false
        state.error = `模型回复失败：${error.message}`
        notify(state.error)
        pump()
      })
    }
    client.start()
  }
  return { start, stop, getStatus: snapshot, perform({ motion, text, expression }) {
    if (motion && !motions.includes(motion)) throw new Error('未知动作')
    if (expression != null && !expressions.includes(expression)) throw new Error('未知表情')
    if (typeof text !== 'string' || text.length > 300) throw new Error('气泡内容无效')
    lastBroadcast = Date.now()
    const event = { type: 'performance', motion: motion || null }
    if (text) event.text = text
    if (expression !== undefined) event.expression = expression
    broadcast(event)
  } }
}
