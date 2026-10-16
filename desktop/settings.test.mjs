import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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

test('非法密钥不能覆盖已经保存的配置和加密文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-settings-'));
  try {
    const store = createSettingsStore(directory, encryption);
    const valid = { baseURL: 'https://example.com/v1', model: 'model-1', images: false, key: 'synthetic-valid-key' };
    await store.save(valid);
    const filename = join(directory, 'ai-settings.json');
    const previousFile = await readFile(filename);
    const previousEnvironment = JSON.stringify(store.environment());
    const previousSummary = JSON.stringify(store.summary());
    for (const key of ['synthetic-中文', 'synthetic-\u200bkey', 'synthetic-é', 'synthetic key', 'synthetic\tkey', 'synthetic\nkey', 'synthetic\u0000key', 'synthetic\u007fkey', 'x'.repeat(4097)]) {
      await assert.rejects(store.save({ ...valid, baseURL: 'https://changed.example/v2', model: 'changed-model', images: true, key }), error => error instanceof Error && /密钥|格式/.test(error.message) && !error.message.includes(key));
      assert.equal(JSON.stringify(store.environment()) === previousEnvironment, true);
      assert.equal(JSON.stringify(store.summary()) === previousSummary, true);
      assert.equal((await readFile(filename)).equals(previousFile), true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('合法密钥裁剪外围空白，空输入沿用且重启可以恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-settings-'));
  try {
    const store = createSettingsStore(directory, encryption);
    const input = { baseURL: 'https://example.com/v1', model: 'model-1', images: false };
    await store.save({ ...input, key: ' \t\r\nsynthetic-valid-key\r\n ' });
    assert.equal(store.environment().AI_API_KEY === 'synthetic-valid-key', true);
    await store.save({ ...input, key: ' \t ' });
    assert.equal(store.environment().AI_API_KEY === 'synthetic-valid-key', true);
    const restored = createSettingsStore(directory, encryption);
    await restored.load();
    assert.equal(restored.environment().AI_API_KEY === 'synthetic-valid-key', true);
    await restored.save({ ...input, removeKey: true });
    assert.equal(restored.summary().configured, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('历史文件中的非法密钥被拒绝且原文件保留，重新配置后恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-settings-'));
  try {
    const filename = join(directory, 'ai-settings.json');
    const invalidKey = 'synthetic-中文';
    const settings = { baseURL: 'https://example.com/v1', model: 'model-1', images: false };
    const original = JSON.stringify({ ...settings, encryptedKey: encryption.encryptString(invalidKey).toString('base64') });
    await writeFile(filename, original);
    const store = createSettingsStore(directory, encryption);
    await assert.rejects(store.load(), error => error instanceof Error && /密钥|模型设置/.test(error.message) && !error.message.includes(invalidKey));
    assert.equal(store.summary().configured, false);
    assert.equal(store.environment().AI_API_KEY === '', true);
    assert.equal((await readFile(filename, 'utf8')) === original, true);
    await store.save({ ...settings, key: 'synthetic-replacement-key' });
    const restored = createSettingsStore(directory, encryption);
    await restored.load();
    assert.equal(restored.summary().configured, true);
    assert.equal(restored.environment().AI_API_KEY === 'synthetic-replacement-key', true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
