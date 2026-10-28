import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createScheduler } from './scheduler.js'

test('bounded queue, deduplication, expiry, and validation', () => {
  let time = 0
  const s = createScheduler({ clock: () => time, maxQueue: 2, ttlMs: 10, dedupeMs: 20, cooldownMs: 0, globalIntervalMs: 0, minGlobalIntervalMs: 0 })
  assert.throws(() => s.enqueue({ userId: '', text: 'a' }), TypeError)
  assert.deepEqual(s.enqueue({ userId: 'a', text: 'hello  world' }), { accepted: true })
  assert.deepEqual(s.enqueue({ userId: 'a', text: 'hello world' }), { accepted: false, reason: 'duplicate' })
  s.enqueue({ userId: 'b', text: 'b' })
  assert.equal(s.enqueue({ userId: 'c', text: 'c' }).reason, 'full')
  assert.equal(s.poll().event.userId, 'a')
  assert.equal(s.enqueue({ userId: 'a', text: 'hello world' }).reason, 'duplicate')
  time = 10
  assert.deepEqual(s.poll(), { event: null, waitMs: null, expired: 1 })
  time = 20
  assert.equal(s.enqueue({ userId: 'a', text: 'hello world' }).accepted, true)
})

test('fair round robin, cooldown and global adaptive rate', () => {
  let time = 0
  const s = createScheduler({ clock: () => time, maxQueue: 4, ttlMs: 1000, cooldownMs: 100, globalIntervalMs: 100, minGlobalIntervalMs: 20 })
  for (const [userId, text] of [['a', '1'], ['a', '2'], ['b', '1'], ['c', '1']]) s.enqueue({ userId, text })
  assert.equal(s.poll().event.userId, 'a')
  assert.equal(s.poll().waitMs, 40)
  time = 40
  assert.equal(s.poll().event.userId, 'b')
  time = 100
  assert.equal(s.poll().event.userId, 'c')
  time = 180
  assert.equal(s.poll().event.userId, 'a')
})

test('cooldown skips blocked users and poll wakes for expiration', () => {
  let time = 0
  const s = createScheduler({ clock: () => time, ttlMs: 20, cooldownMs: 100, globalIntervalMs: 0, minGlobalIntervalMs: 0 })
  s.enqueue({ userId: 'a', text: '1' }); s.poll()
  s.enqueue({ userId: 'a', text: '2' })
  assert.equal(s.poll().waitMs, 20)
  s.enqueue({ userId: 'b', text: '1' })
  assert.equal(s.poll().event.userId, 'b')
  time = 20
  assert.equal(s.poll().expired, 1)
  assert.equal(s.size, 0)
})

test('a busy pair cannot starve a third user', () => {
  const s = createScheduler({ cooldownMs: 0, globalIntervalMs: 0, minGlobalIntervalMs: 0 })
  for (const userId of ['a', 'a', 'b', 'b', 'c']) s.enqueue({ userId, text: userId + s.size })
  assert.deepEqual([s.poll().event.userId, s.poll().event.userId, s.poll().event.userId], ['a', 'b', 'c'])
})

test('status counts all skipped events, including expiry during enqueue or inspection', () => {
  let time = 0
  const s = createScheduler({ clock: () => time, maxQueue: 1, ttlMs: 10 })
  s.enqueue({ userId: 'a', text: 'one' })
  s.enqueue({ userId: 'a', text: 'one' })
  s.enqueue({ userId: 'b', text: 'two' })
  time = 10
  assert.deepEqual(s.getStatus(), { queueSize: 0, skipped: { duplicate: 1, full: 1, expired: 1 } })
  s.enqueue({ userId: 'b', text: 'two' })
  time = 20
  s.enqueue({ userId: 'c', text: 'three' })
  assert.equal(s.getStatus().skipped.expired, 2)
  assert.equal(s.poll().expired, 0)
})
