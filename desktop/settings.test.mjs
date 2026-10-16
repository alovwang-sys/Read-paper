import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore } from './settings.mjs';

const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from([...value].reverse().join('')), decryptString: value => [...value.toString()].reverse().join('') };
test('模型设置只返回安全字段，持久化加密密钥且空输入保留原密钥', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-settings-'));
  try {
    const store = createSettingsStore(directory, encryption);
    await store.load();
    assert.equal(store.summary().configured, false);
    const result = await store.save({ baseURL: 'https://example.com/v1', model: 'model-1', images: true, key: 'private-api-key' });
    assert.equal(result.configured, true);
    assert(!JSON.stringify(result).includes('private-api-key'));
    assert(!(await readFile(join(directory, 'ai-settings.json'), 'utf8')).includes('private-api-key'));
    await store.save({ ...result, key: '' });
    const restored = createSettingsStore(directory, encryption);
    await restored.load();
    assert.equal(restored.environment().AI_API_KEY, 'private-api-key');
    await restored.save({ ...result, removeKey: true });
    assert.equal(restored.environment().AI_API_KEY, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('无安全加密或无效连接时拒绝保存，已有设置不变', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-settings-'));
  try {
    const store = createSettingsStore(directory, { ...encryption, isEncryptionAvailable: () => false });
    const valid = { baseURL: 'https://example.com/v1', model: 'model-1', images: false, key: 'secret' };
    await assert.rejects(store.save(valid), /密钥存储/);
    await assert.rejects(store.save({ ...valid, baseURL: 'http://example.com' }), /HTTPS/);
    await assert.rejects(store.save({ ...valid, key: 'bad\nheader' }), /格式/);
    assert.equal(store.summary().configured, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
