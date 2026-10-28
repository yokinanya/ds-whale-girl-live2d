import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import vm from 'node:vm'

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'))
const source = await readFile(new URL('./stage.js', import.meta.url), 'utf8')
const modelJson = await readJson('../../assets/model/c_0120.model3.json')
const manifest = await readJson('../../assets/model/manifest.json')
const cdi = await readJson('../../assets/model/c_0120.cdi3.json')

function setup(search = '?token=a%26b%20%2B', options = {}) {
  const bubble = { textContent: '', hidden: true }
  const calls = []
  const timers = new Map()
  let timerId = 0
  let now = 0
  let eventSource
  let update
  const model = {
    internalModel: {
      width: 100, height: 200,
      on: (name, callback) => { assert.equal(name, 'beforeModelUpdate'); update = callback },
      coreModel: { addParameterValueById: (...args) => calls.push(['parameter', ...args]) },
    },
    scale: { set: value => calls.push(['scale', value]) },
    position: { set: (...args) => calls.push(['position', ...args]) },
    motion: async (...args) => { calls.push(['motion', ...args]); return true },
  }
  class Application {
    ticker = {}
    view = {}
    stage = { addChild: () => {} }
    renderer = { resize: (...args) => calls.push(['resize', ...args]) }
  }
  class EventSource { constructor(url) { this.url = url; eventSource = this } }
  const window = { location: { search }, innerWidth: 800, innerHeight: 600, addEventListener: () => {} }
  const context = {
    window, URLSearchParams, EventSource,
    PIXI: { Application, Ticker: {}, live2d: { Live2DModel: {
      registerTicker: () => {}, from: async (...args) => { calls.push(['from', ...args]); return model },
    } } },
    document: { getElementById: id => id === 'bubble' ? bubble : { appendChild: () => {} } },
    fetch: async url => options.fetch ? options.fetch(url) : ({
      ok: true, json: async () => url.endsWith('manifest.json') ? manifest : cdi,
    }),
    Date: class extends Date { static now() { return now } },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, at: now + delay }); return timerId },
    clearTimeout: id => timers.delete(id), console: { warn() {}, error: (...args) => calls.push(['error', ...args]) },
  }
  vm.runInNewContext(source, context)
  function advance(ms) {
    const end = now + ms
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      now = next[1].at
      timers.delete(next[0])
      next[1].fn()
    }
    now = end
  }
  return { window, bubble, calls, timers, eventSource, advance, update: () => update() }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const event = fields => ({ type: 'performance', ...fields })

test('SSE 编码、纯文本显示、队列顺序及清空', async () => {
  const ctx = setup()
  assert.equal(ctx.eventSource.url, '/events?token=a%26b+%2B')
  ctx.eventSource.onmessage({ data: JSON.stringify(event({ text: '<img src=x onerror=alert(1)>', motion: 'splash' })) })
  assert.equal(ctx.bubble.textContent, '<img src=x onerror=alert(1)>')
  assert.equal(ctx.bubble.hidden, false)
  assert.equal(ctx.window.whaleStage.perform(event({ text: '第二条' })), true)
  assert.equal(ctx.bubble.textContent, '<img src=x onerror=alert(1)>')
  ctx.advance(5000)
  assert.equal(ctx.bubble.textContent, '第二条')
  assert.equal(ctx.window.whaleStage.perform(event({ text: '等待' })), true)
  assert.equal(ctx.window.whaleStage.perform(event({ text: '' })), true)
  assert.equal(ctx.bubble.hidden, true)
  assert.equal(ctx.bubble.textContent, '')
  assert.equal(ctx.timers.size, 0)
  ctx.advance(5000)
  assert.equal(ctx.bubble.hidden, true)
  ctx.eventSource.onmessage({ data: '{' })
  await flush()
  assert.deepEqual(ctx.calls.find(call => call[0] === 'motion'), ['motion', 'splash', 0, 3])
})

test('队列容量、过期和长度限制', () => {
  const ctx = setup('')
  const perform = ctx.window.whaleStage.perform
  perform(event({ text: '当前' }))
  for (let i = 0; i < 12; i++) perform(event({ text: String(i) }))
  ctx.advance(5000)
  assert.equal(ctx.bubble.textContent, '2')
  ctx.advance(25000)
  assert.equal(ctx.bubble.hidden, true)
  assert.equal(perform(event({ text: '😀'.repeat(500) })), true)
  assert.equal(perform(event({ text: '😀'.repeat(501) })), false)
  assert.equal(ctx.bubble.textContent, '😀'.repeat(500))
})

test('动作白名单及原子校验', async () => {
  const ctx = setup('')
  assert.equal(ctx.eventSource, undefined)
  const groups = ['idle', 'aidale', 'selfie', 'selfieQuick', 'ketchup', 'openLid', 'bubble', 'splash']
  for (const group of groups) {
    assert.ok(modelJson.FileReferences.Motions[group])
    await access(new URL('../../assets/model/' + modelJson.FileReferences.Motions[group][0].File, import.meta.url))
    assert.equal(ctx.window.whaleStage.perform(event({ motion: group })), true)
  }
  for (const item of [null, {}, { type: 'other', text: 'x' }, event({ motion: '' }),
    event({ text: 1 }), event({ text: '不可显示', motion: 'constructor' }),
    event({ text: '不可显示', expression: '' }), event({ expression: 0 })]) {
    assert.equal(ctx.window.whaleStage.perform(item), false)
  }
  assert.equal(ctx.bubble.hidden, true)
  await flush()
  assert.deepEqual(ctx.calls.filter(call => call[0] === 'motion').map(call => call[1]), groups)
})

test('表情目录与 manifest 一致，参数每帧应用且切换和重置可恢复', async () => {
  const ctx = setup()
  const perform = ctx.window.whaleStage.perform
  assert.deepEqual([...ctx.window.whaleStage.expressions], Object.keys(manifest.expressions))
  assert.ok(Object.isFrozen(ctx.window.whaleStage.expressions))
  assert.equal(perform(event({ expression: '哭' })), true)
  await flush()
  ctx.update()
  const params = ctx.calls.filter(call => call[0] === 'parameter')
  assert.deepEqual(params, manifest.expressions['哭'].params.map(p => ['parameter', p.id, p.value]))
  ctx.calls.length = 0
  assert.equal(perform(event({ expression: '喵喵手~喵~动画' })), true)
  ctx.update()
  const ids = new Set(cdi.Parameters.map(p => p.Id))
  assert.deepEqual(ctx.calls, manifest.expressions['喵喵手~喵~动画'].params
    .filter(p => ids.has(p.id)).map(p => ['parameter', p.id, p.value]))
  ctx.calls.length = 0
  assert.equal(perform(event({ expression: null })), true)
  ctx.update()
  assert.deepEqual(ctx.calls, [])
})

test('资源加载失败会报告，不影响文本及动作', async () => {
  const ctx = setup('', { fetch: async () => ({ ok: false, status: 500 }) })
  assert.equal(ctx.window.whaleStage.perform(event({ text: '可用', motion: 'idle', expression: '哭' })), true)
  await flush()
  assert.equal(ctx.bubble.textContent, '可用')
  assert.ok(ctx.calls.some(call => call[0] === 'motion'))
  assert.ok(ctx.calls.some(call => call[0] === 'error' && call[1].includes('表情初始化失败')))
})
