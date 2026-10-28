/**
 * createScheduler(options): enqueue({ userId, text, ...data }) returns
 * { accepted, reason? }; poll() returns { event, waitMs, expired }.
 * Pending events are served round-robin by user, FIFO within each user.
 * All durations are milliseconds; the injected clock returns epoch milliseconds.
 */
export function createScheduler(options = {}) {
  const config = {
    maxQueue: 100, maxTextLength: 1000, ttlMs: 30000, dedupeMs: 10000,
    cooldownMs: 3000, globalIntervalMs: 2000, minGlobalIntervalMs: 500,
    ...options,
  }
  const { clock = Date.now } = config
  for (const key of ['maxQueue', 'maxTextLength', 'ttlMs', 'dedupeMs', 'cooldownMs', 'globalIntervalMs', 'minGlobalIntervalMs']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (['maxQueue', 'maxTextLength', 'ttlMs'].includes(key) ? 1 : 0)) throw new TypeError(`Invalid ${key}`)
  }
  if (config.minGlobalIntervalMs > config.globalIntervalMs || typeof clock !== 'function') throw new TypeError('Invalid scheduler options')
  const queue = []
  const skipped = { duplicate: 0, full: 0, expired: 0 }
  const recent = new Map()
  const users = new Map()
  let lastDispatch = -Infinity
  const now = () => {
    const value = clock()
    if (!Number.isFinite(value)) throw new TypeError('Invalid clock value')
    return value
  }
  function cleanup(time) {
    let expired = 0
    for (let i = queue.length - 1; i >= 0; i--) {
      if (time - queue[i].time >= config.ttlMs) { queue.splice(i, 1); expired++ }
    }
    skipped.expired += expired
    for (const [key, until] of recent) if (until <= time) recent.delete(key)
    for (const [key, until] of users) if (until <= time) users.delete(key)
    return expired
  }
  function interval() {
    const load = Math.min(1, queue.length / config.maxQueue)
    return Math.ceil(config.globalIntervalMs - (config.globalIntervalMs - config.minGlobalIntervalMs) * load)
  }
  return {
    enqueue(event) {
      if (!event || typeof event.userId !== 'string' || !event.userId.trim() || event.userId.length > 256 || typeof event.text !== 'string' || !event.text.trim() || event.text.length > config.maxTextLength) throw new TypeError('Invalid event')
      const time = now()
      cleanup(time)
      const userId = event.userId.trim()
      const key = JSON.stringify([userId, event.text.trim().replace(/\s+/gu, ' ')])
      if (queue.some(item => item.key === key) || recent.has(key)) { skipped.duplicate++; return { accepted: false, reason: 'duplicate' } }
      if (queue.length >= config.maxQueue) { skipped.full++; return { accepted: false, reason: 'full' } }
      queue.push({ event: { ...event, userId }, key, time })
      return { accepted: true }
    },
    poll() {
      const time = now()
      const expired = cleanup(time)
      if (!queue.length) return { event: null, waitMs: null, expired }
      const globalWait = Math.max(0, lastDispatch + interval() - time)
      const eligible = queue.filter(item => !users.has(item.event.userId))
      if (globalWait || !eligible.length) {
        const userWait = eligible.length ? 0 : Math.min(...queue.map(item => users.get(item.event.userId) - time))
        const expiryWait = Math.min(...queue.map(item => item.time + config.ttlMs - time))
        return { event: null, waitMs: Math.min(expiryWait, Math.max(globalWait, userWait)), expired }
      }
      const chosen = eligible[0]
      queue.splice(queue.indexOf(chosen), 1)
      const sameUser = queue.filter(item => item.event.userId === chosen.event.userId)
      for (const item of sameUser) queue.splice(queue.indexOf(item), 1)
      queue.push(...sameUser)
      lastDispatch = time
      if (config.cooldownMs) users.set(chosen.event.userId, time + config.cooldownMs)
      if (config.dedupeMs) {
        recent.set(chosen.key, time + config.dedupeMs)
        while (recent.size > config.maxQueue) recent.delete(recent.keys().next().value)
      }
      return { event: chosen.event, waitMs: 0, expired }
    },
    get size() { cleanup(now()); return queue.length },
    getStatus() { cleanup(now()); return { queueSize: queue.length, skipped: { ...skipped } } },
  }
}
