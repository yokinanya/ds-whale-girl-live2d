import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { defaults, loadSettings, saveSettings, validateConfig } from './settings.js'

const safe = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`protected:${value}`), decryptString: value => value.toString().slice(10) }
test('配置验证限制弹幕地址为回环地址', () => {
  assert.throws(() => validateConfig({ ...defaults, blivechatUrl: 'https://example.com' }))
  assert.throws(() => validateConfig({ ...defaults, roomId: '../1' }))
  assert.equal(validateConfig({ ...defaults, roomId: '123' }).roomId, '123')
})
test('密钥经系统存储处理后保存，重新读取', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'whale-settings-'))
  try {
    await saveSettings(directory, safe, defaults, 'test-secret')
    const raw = await readFile(path.join(directory, 'settings.json'), 'utf8')
    assert.ok(!raw.includes('test-secret'))
    assert.equal((await loadSettings(directory, safe)).apiKey, 'test-secret')
    await assert.rejects(saveSettings(directory, { isEncryptionAvailable: () => false }, defaults, 'secret'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
