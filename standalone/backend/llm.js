/**
 * createLlmClient({ baseUrl, apiKey, model, prompt, motions, timeoutMs?,
 * maxTextLength?, maxResponseBytes?, fetch? }).reply(text) resolves to
 * { text, motion }, where motion is null or an exact member of motions.
 * Failures reject; no credentials or provider response bodies enter errors.
 */
export function createLlmClient(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Invalid model options')
  const { baseUrl, apiKey, model, prompt, motions, timeoutMs = 15000, maxTextLength = 500, maxResponseBytes = 65536, fetch: fetcher = globalThis.fetch } = options
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || !apiKey.trim() || typeof model !== 'string' || !model.trim() || typeof prompt !== 'string' || !Array.isArray(motions) || motions.some(m => typeof m !== 'string' || !m.trim()) || typeof fetcher !== 'function') throw new TypeError('Invalid model options')
  for (const [key, value] of Object.entries({ timeoutMs, maxTextLength, maxResponseBytes })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new TypeError(`Invalid ${key}`)
  }
  let url
  try { url = new URL(baseUrl) } catch { throw new TypeError('Invalid baseUrl') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid baseUrl')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`
  const allowed = new Set(motions)
  async function request(text, signal) {
    let response
    try {
      response = await fetcher(url.href, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [
          { role: 'system', content: `${prompt}\n只返回 JSON 对象：{"text":"回复文本","motion":null}。motion 可为 null 或以下动作之一：${JSON.stringify([...allowed])}。` },
          { role: 'user', content: text },
        ], response_format: { type: 'json_object' } }),
      })
    } catch { throw new Error('Model request failed') }
    if (!response.ok) throw new Error(`Model HTTP error: ${response.status}`)
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('Invalid model response body')
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxResponseBytes) { void reader.cancel().catch(() => {}); throw new Error('Model response too large') }
        chunks.push(value)
      }
    } catch (error) {
      if (error.message === 'Model response too large') throw error
      throw new Error('Model response read failed')
    }
    let output
    try {
      const raw = Buffer.concat(chunks).toString('utf8')
      const envelope = JSON.parse(raw)
      output = JSON.parse(envelope.choices[0].message.content)
    } catch { throw new Error('Invalid model response JSON') }
    if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.text !== 'string' || !output.text.trim() || output.text.length > maxTextLength || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(output.text)) throw new Error('Invalid model output text')
    if (output.motion !== null && (typeof output.motion !== 'string' || !allowed.has(output.motion))) throw new Error('Invalid model output motion')
    return { text: output.text.trim(), motion: output.motion }
  }
  return {
    async reply(text) {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new TypeError('Invalid input text')
      const controller = new AbortController()
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Model request timed out')) }, timeoutMs)
      })
      try { return await Promise.race([request(text, controller.signal), timeout]) }
      finally { clearTimeout(timer); controller.abort() }
    },
  }
}
