import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export const defaults = { blivechatUrl: 'http://127.0.0.1:12450', roomId: '', baseUrl: 'https://api.openai.com/v1', model: '', prompt: '你是一位友善、简洁的直播助手。', queueSize: '100', ttlSeconds: '30', cooldownSeconds: '3', intervalSeconds: '5' }
const keys = Object.keys(defaults)
const limits = { queueSize: [1, 500], ttlSeconds: [5, 600], cooldownSeconds: [0, 600], intervalSeconds: [5, 600] }

export function validateConfig(input) {
  const result = { ...defaults }
  for (const key of keys) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' && !(key in limits && typeof input[key] === 'number')) throw new Error(`配置项 ${key} 无效`)
      const value = String(input[key]).trim()
      if (value.length > 4000) throw new Error(`配置项 ${key} 无效`)
      result[key] = value
    }
  }
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (!/^\d+$/.test(result[key]) || Number(result[key]) < min || Number(result[key]) > max) throw new Error(`${key} 必须在 ${min} 到 ${max} 之间`)
    result[key] = Number(result[key])
  }
  const live = new URL(result.blivechatUrl)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(live.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(live.hostname) || live.username || live.password) throw new Error('blivechat 地址必须是本机地址')
  const llm = new URL(result.baseUrl)
  if (!['http:', 'https:'].includes(llm.protocol) || llm.username || llm.password) throw new Error('模型 API 地址无效')
  if (result.roomId && !/^\d+$/.test(result.roomId)) throw new Error('房间号必须为数字')
  return result
}

export async function loadSettings(directory, safeStorage) {
  let raw
  try { raw = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')) }
  catch (err) { if (err.code === 'ENOENT') return { config: validateConfig(defaults), apiKey: '' }; throw err }
  const config = validateConfig(raw.config || {})
  let apiKey = ''
  if (raw.encryptedKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法解密已保存的 API 密钥')
    apiKey = safeStorage.decryptString(Buffer.from(raw.encryptedKey, 'base64'))
  }
  return { config, apiKey }
}

export async function saveSettings(directory, safeStorage, config, apiKey) {
  const checked = validateConfig(config)
  if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error('系统密钥存储不可用，无法安全保存 API 密钥')
  const encryptedKey = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : ''
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, 'settings.json')
  const temp = `${file}.new`
  await writeFile(temp, JSON.stringify({ version: 1, config: checked, encryptedKey }, null, 2), { mode: 0o600 })
  const { rename } = await import('node:fs/promises')
  await rename(temp, file)
  return checked
}
