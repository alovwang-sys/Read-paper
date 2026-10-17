import { mkdir, lstat, realpath, readdir, open, rename, unlink, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MARKER = '.papertrail-project.json';
const MANIFEST = '.papertrail-manifest.json';
const TRANSACTION = '.papertrail-transaction';
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ASSET = 64 * 1024 * 1024;
const MAX_TEXT = 8 * 1024 * 1024;
const locks = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const conflict = path => fail('project_files_conflict', `研究目录中的 ${path} 已被修改或占用，未覆盖现有内容。请恢复原导出内容，或将整个 Papertrail 文件夹另存并移走后重试。`);

function validPath(path) {
  if (typeof path !== 'string' || path.length > 240) return false;
  if (['README.md', 'research.json', 'research.md'].includes(path)) return true;
  const match = /^(library|assets|images|cards|excerpts|drafts|sessions|boards)\/([A-Za-z0-9][A-Za-z0-9._-]{0,159})\.(md|json|pdf|png|jpg|jpeg|webp|gif)$/.exec(path);
  if (!match || match[2].includes('..')) return false;
  return ['library', 'assets', 'images'].includes(match[1]) || ['md', 'json'].includes(match[3]);
}

function payloadFiles(payload) {
  if (!object(payload) || !Array.isArray(payload.files) || payload.files.length > 10_000) throw fail('invalid_project_files', '研究文件清单无效。', 400);
  const files = new Map();
  let total = 0;
  for (const file of payload.files) {
    if (!object(file) || !validPath(file.path) || files.has(file.path) || !validHash(file.hash)) throw fail('invalid_project_files', '研究文件路径、内容或 SHA-256 无效。', 400);
    const binary = /\.(pdf|png|jpg|jpeg|webp|gif)$/.test(file.path);
    if (file.encoding !== (binary ? 'base64' : 'utf8')) throw fail('invalid_project_files', '研究文件编码不正确。', 400);
    if (file.reuse === true) {
      if (file.content !== undefined) throw fail('invalid_project_files', '复用研究文件不能同时携带新内容。', 400);
      files.set(file.path, { hash: file.hash, encoding: file.encoding, reuse: true });
      continue;
    }
    if (typeof file.content !== 'string' || file.reuse !== undefined) throw fail('invalid_project_files', '研究文件内容无效。', 400);
    const limit = binary ? MAX_ASSET : MAX_TEXT;
    if (file.content.length > (binary ? Math.ceil(limit / 3) * 4 : limit)) throw fail('project_files_too_large', '单个研究文件过大。', 413);
    if (binary && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))) throw fail('invalid_project_files', '研究资产的 base64 编码无效。', 400);
    const bytes = Buffer.from(file.content, file.encoding);
    if (bytes.length > limit || (total += bytes.length) > MAX_TOTAL) throw fail('project_files_too_large', '研究文件总量不能超过 256 MiB，单个资产不能超过 64 MiB。', 413);
    if (binary && bytes.toString('base64') !== file.content || hash(bytes) !== file.hash) throw fail('project_files_hash_mismatch', '研究文件 SHA-256 不匹配，未写入任何内容。', 400);
    files.set(file.path, { bytes, hash: file.hash, size: bytes.length, encoding: file.encoding });
  }
  if (!files.has('README.md') || !files.has('research.json')) throw fail('invalid_project_files', '研究文件须包含 README.md 和 research.json。', 400);
  return { files, total };
}

async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function directory(path) {
  const stat = await info(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw fail('invalid_project_files_directory', '研究文件目录不是普通文件夹；未跟随符号链接或覆盖已有内容。');
}
async function readRegular(path, limit = MAX_TOTAL) {
  const stat = await info(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw conflict(path.split(/[\\/]/).pop());
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > limit) throw conflict(path.split(/[\\/]/).pop());
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw conflict(path.split(/[\\/]/).pop());
    return bytes;
  } finally { await handle.close(); }
}
async function json(path, limit) {
  const bytes = await readRegular(path, limit);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw fail('invalid_project_files_metadata', '研究文件元数据无法识别；已有文件未覆盖。'); }
}
async function exclusive(path, bytes) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function atomicJSON(root, name, value) {
  const temporary = join(root, `.${randomUUID()}.tmp`);
  await exclusive(temporary, jsonBytes(value));
  try { await rename(temporary, join(root, name)); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
async function parents(root, path, create = false) {
  await directory(root);
  const parent = dirname(path);
  if (parent === '.') return;
  const target = join(root, parent);
  if (create) await mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await info(target);
  if (!stat && !create) return;
  await directory(target);
}
function validManifest(value, project) {
  if (!object(value) || value.version !== 1 || value.projectId !== project.projectId || !object(value.files) || value.researchId !== (project.researchId || null) || Object.keys(value.files).length > 10_000 || value.updatedAt !== null && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))) return false;
  let total = 0;
  return Object.entries(value.files).every(([path, file]) => {
    const binary = /\.(pdf|png|jpg|jpeg|webp|gif)$/.test(path);
    return validPath(path) && object(file) && validHash(file.hash) && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= (binary ? MAX_ASSET : MAX_TEXT) && (total += file.size) <= MAX_TOTAL && file.encoding === (binary ? 'base64' : 'utf8');
  });
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function fileHash(root, path, expectedSize) {
  await parents(root, path);
  const bytes = await readRegular(join(root, path), expectedSize ?? MAX_ASSET);
  if (bytes && expectedSize !== undefined && bytes.length !== expectedSize) throw conflict(path);
  return bytes ? hash(bytes) : undefined;
}
async function removeKnown(path, expected) {
  const bytes = await readRegular(path);
  if (bytes === undefined) return;
  if (hash(bytes) !== expected) throw conflict(path.split(/[\\/]/).pop());
  await unlink(path);
}

async function cleanup(root, transaction) {
  const staging = join(root, TRANSACTION);
  for (const [index, operation] of transaction.operations.entries()) {
    if (operation.nextHash) await removeKnown(join(staging, `${index}.new`), operation.nextHash);
    if (operation.oldHash) await removeKnown(join(staging, `${index}.old`), operation.oldHash);
  }
  // Only remove known bytes. User-added files inside this directory are preserved.
  const entries = await readdir(staging);
  if (entries.some(name => name !== 'journal.json')) throw conflict(TRANSACTION);
  await removeKnown(join(staging, 'journal.json'), hash(jsonBytes(transaction)));
  await rmdir(staging);
}

async function recover(root, project, manifest) {
  const staging = join(root, TRANSACTION);
  if (!await info(staging)) return manifest;
  await directory(staging);
  const transaction = await json(join(staging, 'journal.json'), 16 * 1024 * 1024);
  if (!object(transaction) || transaction.version !== 1 || transaction.projectId !== project.projectId || !Number.isInteger(transaction.pid) || transaction.pid <= 0 || transaction.pid > 2_147_483_647 || !validManifest(transaction.previous, project) || !validManifest(transaction.next, project) || !Array.isArray(transaction.operations)) throw fail('project_files_recovery_required', '上次研究文件保存未完成，恢复信息无法确认。保留了目录内容，请先检查后重试。');
  const expected = operations(transaction.previous, transaction.next);
  if (!same(expected, transaction.operations)) throw fail('invalid_project_files_metadata', '研究文件恢复清单不匹配，未改动任何文件。');
  if (transaction.pid !== process.pid) {
    try { process.kill(transaction.pid, 0); throw fail('project_files_busy', '另一个进程正在保存研究文件，请稍后重试。'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  if (same(manifest, transaction.next)) { await cleanup(root, transaction); return manifest; }
  if (!same(manifest, transaction.previous)) throw fail('project_files_recovery_required', '研究文件清单与恢复记录不一致，已有内容未覆盖。');
  // Roll back only our exact bytes; an external edit always stops recovery.
  for (let index = transaction.operations.length - 1; index >= 0; index--) {
    const operation = transaction.operations[index];
    const current = await fileHash(root, operation.path);
    const backup = await readRegular(join(staging, `${index}.old`));
    if (backup && hash(backup) !== operation.oldHash) throw conflict(operation.path);
    if (current !== undefined && current !== operation.oldHash && current !== operation.nextHash) throw conflict(operation.path);
    if (operation.oldHash) {
      if (backup) {
        if (current !== undefined) await removeKnown(join(root, operation.path), current);
        await parents(root, operation.path, true);
        await rename(join(staging, `${index}.old`), join(root, operation.path));
      } else if (current !== operation.oldHash) throw fail('project_files_recovery_required', `无法恢复 ${operation.path}，旧内容仍按原位置或恢复记录保留，请检查目录。`);
    } else if (current !== undefined) await removeKnown(join(root, operation.path), operation.nextHash);
  }
  await cleanup(root, transaction);
  return manifest;
}
function operations(previous, next) {
  return [...new Set([...Object.keys(previous.files), ...Object.keys(next.files)])].sort().flatMap(path => {
    const oldHash = previous.files[path]?.hash, nextHash = next.files[path]?.hash;
    return oldHash === nextHash ? [] : [{ path, ...(oldHash ? { oldHash } : {}), ...(nextHash ? { nextHash } : {}) }];
  });
}
async function rootDirectory(project) {
  if (!object(project) || !validId(project.projectId) || project.researchId !== undefined && !validId(project.researchId) || typeof project.path !== 'string' || !isAbsolute(project.path) || resolve(project.path) !== project.path || project.path.includes('\0')) throw fail('invalid_project_files', '研究目录身份无效。', 400);
  await directory(project.path);
  if (await realpath(project.path) !== project.path) throw fail('invalid_project_files_directory', '研究目录含符号链接，请重新关联真实目录。');
  const root = join(project.path, 'Papertrail');
  let created = false;
  await mkdir(root, { mode: 0o700 }).then(() => { created = true; }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await directory(root);
  const marker = await json(join(root, MARKER), 65_536);
  if (!marker) {
    if (!created) throw fail('project_files_unmanaged', '目录中已有非托管的 Papertrail 文件夹，未覆盖。请重命名该文件夹后重试。');
    await exclusive(join(root, MARKER), jsonBytes({ version: 1, projectId: project.projectId, researchId: project.researchId || null }));
  } else if (marker.version !== 1 || marker.projectId !== project.projectId || marker.researchId !== (project.researchId || null)) throw fail('project_files_identity_mismatch', 'Papertrail 文件夹属于另一研究，已有内容未覆盖。');
  let manifest = await json(join(root, MANIFEST), 8 * 1024 * 1024);
  if (!manifest) {
    if ((await readdir(root)).some(name => name !== MARKER)) throw fail('invalid_project_files_metadata', '研究文件清单缺失，已有内容未覆盖。');
    manifest = { version: 1, projectId: project.projectId, researchId: project.researchId || null, updatedAt: null, files: {} };
    await atomicJSON(root, MANIFEST, manifest);
  }
  if (!validManifest(manifest, project)) throw fail('invalid_project_files_metadata', '研究文件清单身份或格式无效，已有内容未覆盖。');
  return { root, manifest: await recover(root, project, manifest) };
}

async function write(project, payload) {
  const validated = payloadFiles(payload);
  const { files } = validated;
  let total = validated.total;
  const { root, manifest: previous } = await rootDirectory(project);
  // Check the whole last successful set, including exports removed by the app.
  for (const [path, record] of Object.entries(previous.files)) if (await fileHash(root, path, record.size) !== record.hash) throw conflict(path);
  for (const [path, file] of files) {
    if (!file.reuse) continue;
    const previousFile = previous.files[path];
    if (previousFile?.hash !== file.hash || previousFile.encoding !== file.encoding) throw fail('project_files_reuse_unavailable', '所复用的研究文件尚未成功保存，请重新发送完整文件。', 400);
    file.size = previousFile.size;
    if ((total += file.size) > MAX_TOTAL) throw fail('project_files_too_large', '研究文件总量不能超过 256 MiB。', 413);
  }
  for (const path of files.keys()) if (!previous.files[path] && await fileHash(root, path) !== undefined) throw conflict(path);
  const next = { ...previous, updatedAt: new Date().toISOString(), files: Object.fromEntries([...files].map(([path, file]) => [path, { hash: file.hash, size: file.size, encoding: file.encoding }])) };
  const changed = operations(previous, next);
  if (!changed.length) return { updatedAt: previous.updatedAt, files: files.size, bytes: total, written: 0, skipped: files.size };
  for (const path of [MANIFEST, ...changed.filter(item => item.oldHash).map(item => item.path)]) {
    if (((await lstat(join(root, path))).mode & 0o222) === 0) throw fail('project_files_readonly', `研究文件 ${path} 被设为只读，已有内容未改动。`);
  }
  const transaction = { version: 1, projectId: project.projectId, pid: process.pid, previous, next, operations: changed };
  const staging = join(root, TRANSACTION);
  await mkdir(staging, { mode: 0o700 });
  await exclusive(join(staging, 'journal.json'), jsonBytes(transaction));
  try {
    for (const [index, operation] of changed.entries()) {
      if (operation.nextHash) await exclusive(join(staging, `${index}.new`), files.get(operation.path).bytes);
    }
    for (const [index, operation] of changed.entries()) {
      await parents(root, operation.path, true);
      if (await fileHash(root, operation.path) !== operation.oldHash) throw conflict(operation.path);
      if (operation.oldHash) await rename(join(root, operation.path), join(staging, `${index}.old`));
      if (operation.nextHash) await rename(join(staging, `${index}.new`), join(root, operation.path));
    }
    const current = await json(join(root, MANIFEST), 8 * 1024 * 1024);
    if (!same(current, previous)) throw fail('invalid_project_files_metadata', '保存期间研究文件清单发生变化；保留恢复信息，未提交新清单。');
    await atomicJSON(root, MANIFEST, next);
    await cleanup(root, transaction);
  } catch (error) {
    // A failed rollback leaves its journal and old bytes for a later safe retry.
    try { await recover(root, project, await json(join(root, MANIFEST), 8 * 1024 * 1024)); } catch { /* Preserve the original error and recovery files. */ }
    throw error;
  }
  return { updatedAt: next.updatedAt, files: files.size, bytes: total, written: changed.filter(item => item.nextHash).length, skipped: files.size - changed.filter(item => item.nextHash).length };
}

/** Writes a complete research-scoped file set; native agent logs stay in their own runtime. */
export function writeProjectFiles(project, payload) {
  const key = project?.path;
  const work = (locks.get(key) || Promise.resolve()).catch(() => {}).then(() => write(project, payload));
  locks.set(key, work);
  work.finally(() => { if (locks.get(key) === work) locks.delete(key); }).catch(() => {});
  return work;
}
