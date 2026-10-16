import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateAISettings } from '../server/ai.mjs';

const defaults = { baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3-flash', images: false };

export function createSettingsStore(directory, encryption) {
  const filename = join(directory, 'ai-settings.json');
  let settings = { ...defaults };
  let key = '';
  const environment = () => ({ AI_BASE_URL: settings.baseURL, AI_MODEL: settings.model, AI_IMAGES: String(settings.images), AI_API_KEY: key });
  const summary = () => ({ ...settings, configured: !!key });
  return {
    environment,
    summary,
    async load() {
      let saved;
      try { saved = JSON.parse(await readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法读取模型设置。原文件已保留，请重新配置连接。'); }
      const next = { baseURL: saved.baseURL, model: saved.model, images: saved.images };
      if (typeof next.baseURL !== 'string' || typeof next.model !== 'string' || typeof next.images !== 'boolean' || typeof saved.encryptedKey !== 'string') throw new Error('模型设置格式不完整，请重新配置连接。');
      let nextKey = '';
      try {
        if (saved.encryptedKey) nextKey = encryption.decryptString(Buffer.from(saved.encryptedKey, 'base64'));
        validateAISettings({ AI_BASE_URL: next.baseURL, AI_MODEL: next.model, AI_IMAGES: String(next.images), AI_API_KEY: nextKey });
      } catch { throw new Error('无法解密或验证模型设置。请在此电脑重新配置密钥。'); }
      settings = next;
      key = nextKey;
    },
    async save(input) {
      if (!input || typeof input !== 'object' || typeof input.baseURL !== 'string' || typeof input.model !== 'string' || typeof input.images !== 'boolean'
        || (input.key !== undefined && (typeof input.key !== 'string' || input.key.length > 4096 || /[\r\n]/.test(input.key)))) throw new Error('模型设置格式不正确。');
      const next = { baseURL: input.baseURL.trim(), model: input.model.trim(), images: input.images };
      const nextKey = input.removeKey === true ? '' : input.key?.trim() || key;
      validateAISettings({ AI_BASE_URL: next.baseURL, AI_MODEL: next.model, AI_IMAGES: String(next.images), AI_API_KEY: nextKey });
      if (nextKey && !encryption.isEncryptionAvailable()) throw new Error('系统密钥存储暂不可用，未保存密钥。请稍后重试。');
      const encryptedKey = nextKey ? encryption.encryptString(nextKey).toString('base64') : '';
      await mkdir(directory, { recursive: true });
      const temporary = `${filename}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...next, encryptedKey }), { mode: 0o600 });
      await rename(temporary, filename);
      settings = next;
      key = nextKey;
      return summary();
    },
  };
}
