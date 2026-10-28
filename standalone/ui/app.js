const form = document.querySelector('#settings')
const status = document.querySelector('#status')
const error = document.querySelector('#error')
let populated = false
function render(state) {
  status.textContent = state.status || '未连接'
  if (state.details) {
    const d = state.details
    document.querySelector('#statistics').textContent = `连接：${d.connection}；队列：${d.queueSize}；重复：${d.skipped.duplicate}；满队列：${d.skipped.full}；过期：${d.skipped.expired}；无效：${d.skipped.invalid}${d.error ? '；错误：' + d.error : ''}`
  }
  document.querySelector('#overlay').value = state.overlayUrl || ''
  document.querySelector('#secret').textContent = state.secretConfigured ? '（已保存）' : '（未设置）'
  if (!populated && state.config) {
    for (const [key, value] of Object.entries(state.config)) if (form.elements[key]) form.elements[key].value = value
    const select = document.querySelector('#expression')
    for (const expression of state.expressions || []) select.add(new Option(expression, expression))
    populated = true
  }
}
async function run(action) {
  error.textContent = ''
  try { const value = await action(); if (value && value.config) render(value) }
  catch (err) { error.textContent = err.message || String(err) }
}
form.addEventListener('submit', event => {
  event.preventDefault()
  run(async () => { const result = await window.whale.saveConfig(Object.fromEntries(new FormData(form))); form.elements.apiKey.value = ''; return result })
})
document.querySelector('#connect').onclick = () => run(() => window.whale.connect(document.querySelector('#authCode').value.trim()))
document.querySelector('#disconnect').onclick = () => run(() => window.whale.disconnect())
document.querySelector('#copy').onclick = () => run(() => window.whale.copyOverlayUrl())
document.querySelector('#perform').onclick = () => run(() => {
  const expression = document.querySelector('#expression').value
  const payload = { motion: document.querySelector('#motion').value, text: document.querySelector('#text').value }
  if (expression) payload.expression = expression === '__reset__' ? null : expression
  return window.whale.perform(payload)
})
window.whale.onState(render)
run(() => window.whale.getState())
