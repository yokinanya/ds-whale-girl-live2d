import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLlmClient } from './llm.js'

const options = { baseUrl: 'https://example.test/v1/', apiKey: 'secret', model: 'model', prompt: '友善', motions: ['wave'], timeoutMs: 100 }
const envelope = content => JSON.stringify({ choices: [{ message: { content } }] })
const response = content => new Response(envelope(content))

test('sends OpenAI-compatible request and validates response', async () => {
  let sent
  const client = createLlmClient({ ...options, fetch: async (url, init) => { sent = { url, init }; return response(JSON.stringify({ text: '  你好  ', motion: 'wave' })) } })
  assert.deepEqual(await client.reply('弹幕'), { text: '你好', motion: 'wave' })
  assert.equal(sent.url, 'https://example.test/v1/chat/completions')
  assert.equal(sent.init.headers.Authorization, 'Bearer secret')
  assert.equal(sent.init.redirect, 'error')
  const body = JSON.parse(sent.init.body)
  assert.equal(body.model, 'model')
  assert.equal(body.messages[1].content, '弹幕')
  assert.deepEqual(body.response_format, { type: 'json_object' })
})

test('rejects invalid text, motions, envelope and oversized bodies', async () => {
  for (const output of [null, {}, { text: '<img>', motion: null }, { text: 'x\n', motion: null }, { text: 'x', motion: 'other' }, { text: 'x'.repeat(501), motion: null }]) {
    const client = createLlmClient({ ...options, fetch: async () => response(JSON.stringify(output)) })
    await assert.rejects(client.reply('x'), /Invalid model output/)
  }
  await assert.rejects(createLlmClient({ ...options, fetch: async () => new Response('not json') }).reply('x'), /Invalid model response JSON/)
  await assert.rejects(createLlmClient({ ...options, maxResponseBytes: 5, fetch: async () => response('{}') }).reply('x'), /too large/)
})

test('reports HTTP, network and timeout failures without leaking secrets', async () => {
  await assert.rejects(createLlmClient({ ...options, fetch: async () => new Response('secret', { status: 401 }) }).reply('x'), /^Error: Model HTTP error: 401$/)
  await assert.rejects(createLlmClient({ ...options, fetch: async () => { throw Error('secret') } }).reply('x'), /^Error: Model request failed$/)
  let signal
  const client = createLlmClient({ ...options, timeoutMs: 10, fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}) } })
  await assert.rejects(client.reply('x'), /timed out/)
  assert.equal(signal.aborted, true)
  assert.throws(() => createLlmClient({ ...options, baseUrl: 'https://user:pass@example.test' }), /baseUrl/)
  await assert.rejects(client.reply(''), /Invalid input/)
})
