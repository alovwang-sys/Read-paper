import { mkdir, readFile, writeFile, rename, realpath, lstat, readdir, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, basename, parse } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sanitizeAgentProgress } from './codex-runtime.mjs';

const agents = ['codex', 'opencode', 'claude'];
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const digest = value => createHash('sha256').update(value).digest('hex');
const key = body => JSON.stringify([body.workspaceId, body.researchId]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = body => {
  if (!object(body) || !validId(body.workspaceId) || !validId(body.researchId)) throw fail(400, 'invalid_request', '研究身份无效。');
};
const safeText = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, limit) : '';

async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

export function createProjectStore({ stateDir, runtimes, isBusy = () => false, queryTimeoutMs = 12_000 }) {
  const registryPath = join(stateDir, 'projects.json');
  let registry;
  let writes = Promise.resolve();
  let bindingWrites = Promise.resolve();
  const ready = (async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try {
      registry = JSON.parse(await readFile(registryPath, 'utf8'));
      if (registry.version !== 1 || !object(registry.bindings) || !object(registry.sessions)) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail(500, 'project_read_failed', '无法读取研究目录关联；已有记录未覆盖。');
      registry = { version: 1, bindings: {}, sessions: {} };
    }
  })();
  ready.catch(() => {});
  const save = () => { writes = writes.catch(() => {}).then(() => atomicJSON(registryPath, registry)); return writes; };
  async function nativeQuery(adapter, method, input) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        adapter[method]({ ...input, signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { reject(fail(504, 'history_timeout', '读取原生记录超时，已保留上次内容，请稍后刷新。')); controller.abort(); }, queryTimeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function canonical(path, allowNew = false, browsing = false) {
    if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw fail(400, 'invalid_directory', '请选择有效的绝对目录。');
    let actual;
    try { actual = await realpath(path); }
    catch (error) {
      if (!allowNew || error.code !== 'ENOENT' || !basename(path) || ['.', '..'].includes(basename(path))) throw fail(400, 'directory_unavailable', '目录不存在或无法访问，请重新选择。');
      try { actual = join(await realpath(dirname(path)), basename(path)); } catch { throw fail(400, 'directory_unavailable', '请先选择已存在的父目录。'); }
    }
    const home = await realpath(homedir());
    if (!browsing && (actual === parse(actual).root || actual === home) || /(?:^|[\\/])(?:\.codex|\.claude|\.ssh|\.git|\.read-paper|secrets)(?:[\\/]|$)/i.test(actual)) throw fail(400, 'invalid_directory', '请选择具体研究文件夹，不能使用系统根目录、整个用户目录或配置目录。');
    try { if (!(await lstat(actual)).isDirectory()) throw new Error(); }
    catch (error) { if (!(allowNew && error.code === 'ENOENT')) throw fail(400, 'invalid_directory', '所选位置不是可用目录。'); }
    return actual;
  }
  async function managed(path, create = false) {
    const directory = join(path, '.read-paper');
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (!create && error.code === 'ENOENT') return undefined;
      throw fail(400, 'invalid_project', '研究元数据目录不可用，未覆盖已有文件。');
    }
    return directory;
  }
  async function projectManifest(path) {
    const directory = await managed(path);
    if (!directory) return undefined;
    const file = join(directory, 'project.json');
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) throw new Error();
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (manifest.version !== 1 || !validId(manifest.projectId) || !validId(manifest.researchId)) throw new Error();
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw fail(400, 'invalid_project', '已有研究清单无法识别，未覆盖文件。');
    }
  }
  async function binding(body) {
    identity(body); await ready;
    const item = registry.bindings[key(body)];
    if (!item || body.bindingId && body.bindingId !== item.id) throw fail(409, 'project_required', '请先为当前研究选择目录。');
    if (await canonical(item.path) !== item.path) throw fail(409, 'directory_changed', '研究目录位置已改变，请重新连接。');
    const manifest = await projectManifest(item.path);
    if (manifest?.projectId !== item.projectId) throw fail(409, 'directory_changed', '研究目录标识不匹配，已有会话未改动。');
    return item;
  }
  const summary = (item, ref, origin) => ({ id: ref, agentId: item.agentId, nativeSessionId: item.id, title: safeText(item.title) || '原生对话', updatedAt: safeText(item.updatedAt, 40),
    state: ['idle', 'busy'].includes(item.state) ? item.state : 'unknown', canResume: item.canResume === true, ...(item.reason ? { reason: safeText(item.reason, 1000) } : {}), origin });
  const unresolvedStop = { state: 'unknown', canResume: false, reason: '上次停止尚未得到原生服务确认，请在原生应用核对记录；这里仍可查看，或另开新对话。' };
  async function remember(project, agentId, nativeId, origin = 'native') {
    await ready;
    if (!agents.includes(agentId) || typeof nativeId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(nativeId)) throw fail(502, 'invalid_session', '原生会话标识不正确。');
    const existing = Object.entries(registry.sessions).find(([, s]) => s.projectId === project.projectId && s.agentId === agentId && s.nativeId === nativeId);
    if (existing) {
      if (origin === 'read-paper' && !existing[1].managed) { existing[1].managed = true; await save(); }
      return existing[0];
    }
    const ref = randomUUID();
    registry.sessions[ref] = { projectId: project.projectId, agentId, nativeId, origin };
    await save(); return ref;
  }
  async function session(body, project) {
    if (typeof body.sessionRef !== 'string') throw fail(400, 'invalid_session', '请选择本研究中的原生对话。');
    const item = registry.sessions[body.sessionRef];
    if (!item || item.projectId !== project.projectId || body.agentId && item.agentId !== body.agentId) throw fail(404, 'session_not_found', '此对话不属于当前研究。');
    return item;
  }
  async function read(body) {
    const project = await binding(body), item = await session(body, project);
    const adapter = runtimes[item.agentId];
    if (!adapter?.readSession) throw fail(503, 'sessions_unsupported', '此运行时暂不支持读取原生记录。');
    const native = await nativeQuery(adapter, 'readSession', { cwd: project.path, sessionId: item.nativeId });
    if (native.id !== item.nativeId || !Array.isArray(native.messages)) throw fail(502, 'invalid_session', '原生历史格式无效。');
    let size = 0, truncated = native.truncated === true;
    const messages = [];
    for (const message of native.messages.slice(0, 2000)) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.id !== 'string' || typeof message.text !== 'string') continue;
      let text = safeText(message.text, 100_000), requestId;
      if (text.length < message.text.length) truncated = true;
      // Only our exact envelope is shortened; external prompts remain readable source material.
      const match = message.role === 'user' && text.match(/^\[Read-paper requestId=([A-Za-z0-9._:-]+)\]\n/);
      if (match && text.includes('\n用户本次问题：\n')) { requestId = match[1]; text = text.slice(text.lastIndexOf('\n用户本次问题：\n') + '\n用户本次问题：\n'.length); }
      if ((size += text.length) > 1_000_000) break;
      const events = [];
      for (const value of Array.isArray(message.events) ? message.events.slice(0, 200) : []) {
        const sanitized = sanitizeAgentProgress(value);
        if (!sanitized) continue;
        const { type: _type, ...event } = sanitized;
        const length = JSON.stringify(event).length;
        if (size + length > 1_000_000) { truncated = true; break; }
        size += length; events.push(event);
      }
      messages.push({ id: safeText(message.id, 200), role: message.role, text, ...(events.length ? { events } : {}), ...(requestId ? { requestId } : {}), ...(message.createdAt ? { createdAt: safeText(message.createdAt, 40) } : {}) });
    }
    const busy = isBusy(item.agentId, item.nativeId);
    const owned = (item.managed || item.origin === 'read-paper') && native.state !== 'busy' && !item.stopUnconfirmed;
    const result = { ...summary({ ...native, agentId: item.agentId, ...(owned ? { canResume: true } : {}), ...(item.stopUnconfirmed ? unresolvedStop : {}), ...(busy ? { state: 'busy', canResume: false, reason: '此会话正在生成，请等待本轮结束。' } : {}) }, body.sessionRef, item.origin), messages,
      ...(truncated || messages.length < native.messages.length ? { truncated: true } : {}) };
    try {
      const directory = await managed(project.path, true);
      await atomicJSON(join(directory, `conversation-${digest(`${item.agentId}:${item.nativeId}`)}.json`), { version: 1, projectId: project.projectId, archivedAt: new Date().toISOString(), ...result });
    } catch { result.archiveError = '原生历史已读取，但研究目录的可读归档未能更新。'; }
    return result;
  }
  return {
    binding, remember, read,
    async markUnconfirmed(project, agentId, nativeId) {
      const ref = await remember(project, agentId, nativeId, 'read-paper');
      registry.sessions[ref].stopUnconfirmed = true;
      await save();
    },
    async preview(body) {
      identity(body); await ready;
      const path = await canonical(body.path, true);
      const manifest = await projectManifest(path);
      if (manifest && (manifest.researchId !== body.researchId || manifest.workspaceId && manifest.workspaceId !== body.workspaceId)) throw fail(409, 'directory_in_use', `该目录已关联研究“${safeText(manifest.title) || manifest.researchId}”，请选择其他目录或打开已有研究。`);
      return { path, name: basename(path) };
    },
    async browse(body) {
      identity(body);
      const path = body.path ? await canonical(body.path, false, true) : homedir();
      const entries = await readdir(path, { withFileTypes: true }).catch(() => { throw fail(400, 'directory_unavailable', '无法浏览此目录，请检查访问权限。'); });
      return { path, ...(dirname(path) !== path ? { parent: dirname(path) } : {}), directories: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200).map(e => ({ name: e.name, path: join(path, e.name) })) };
    },
    async status(body) {
      identity(body); await ready;
      if (!registry.bindings[key(body)]) return undefined;
      const project = await binding(body);
      return { ...project, name: basename(project.path) };
    },
    async bind(body) {
      const work = async () => {
      const preview = await this.preview(body);
      const existing = registry.bindings[key(body)];
      if (existing && existing.path !== preview.path) throw fail(409, 'directory_changed', '此研究已绑定另一目录。请重新定位原研究目录，不能覆盖原生会话归属。');
      const duplicate = Object.entries(registry.bindings).find(([owner, b]) => b.path === preview.path && owner !== key(body));
      if (duplicate) throw fail(409, 'directory_in_use', '该目录已经关联其他研究。');
      await mkdir(preview.path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await access(preview.path, constants.W_OK).catch(() => { throw fail(400, 'directory_unwritable', '此目录不可写，不能保存研究清单；请选择可写的研究目录。'); });
      const previous = await projectManifest(preview.path);
      const projectId = previous?.projectId || randomUUID();
      const directory = await managed(preview.path, true);
      if (!previous || previous.title !== preview.name) await atomicJSON(join(directory, 'project.json'), previous ? { ...previous, title: preview.name } : { version: 1, projectId, workspaceId: body.workspaceId, researchId: body.researchId, title: preview.name, createdAt: new Date().toISOString() });
      const result = { id: existing?.id || randomUUID(), projectId, path: preview.path, name: preview.name, researchId: body.researchId };
      registry.bindings[key(body)] = result; await save();
      return result;
      };
      const result = bindingWrites.catch(() => {}).then(work);
      bindingWrites = result;
      return result;
    },
    async list(body) {
      const project = await binding(body);
      const sessions = [], errors = [];
      await Promise.all(agents.map(async agentId => {
        try {
          if (!runtimes[agentId]?.listSessions) throw new Error('此运行时暂不支持发现项目会话。');
          const result = await nativeQuery(runtimes[agentId], 'listSessions', { cwd: project.path });
          for (const item of (result.sessions || []).slice(0, 100)) {
            const ref = await remember(project, agentId, item.id);
            const { origin, managed, stopUnconfirmed } = registry.sessions[ref];
            const owned = (managed || origin === 'read-paper') && item.state !== 'busy' && !stopUnconfirmed;
            sessions.push(summary({ ...item, agentId, ...(owned ? { canResume: true } : {}), ...(stopUnconfirmed ? unresolvedStop : {}), ...(isBusy(agentId, item.id) ? { state: 'busy', canResume: false } : {}) }, ref, origin));
          }
          if (result.nextCursor) errors.push({ agentId, error: '仅显示最近 100 条原生记录，较早记录尚未载入。' });
        } catch (error) { errors.push({ agentId, error: safeText(error.message, 1000) || '读取原生会话失败。' }); }
      }));
      return { sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), errors };
    },
    async resume(body) {
      const project = await binding(body), item = await session(body, project);
      const native = await read(body);
      if (!native.canResume || native.state === 'busy') throw fail(409, 'session_busy', native.reason || '无法确认原生会话空闲，当前只可查看记录。');
      return { project, nativeSessionId: item.nativeId, agentId: item.agentId };
    },
    async archiveRequest(project, request) {
      const directory = await managed(project.path, true);
      await atomicJSON(join(directory, `request-${digest(request.requestId)}.json`), { version: 1, ...request });
    },
    async materialize(project, request) {
      const parent = join(await managed(project.path, true), 'materials');
      await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) throw fail(400, 'invalid_project', '研究材料目录不可用，未覆盖已有文件。');
      const directory = join(parent, digest(request.requestId));
      await mkdir(directory, { mode: 0o700 });
      const materials = request.context.map((item, index) => `## [${index + 1}] ${item.title}\nevidenceId: ${item.evidenceId}\ndocumentId: ${item.documentId}\ndocumentHash: ${item.documentHash}\nPDF 第 ${item.pageIndex + 1} 页\n\n${item.quote}`).join('\n\n');
      await writeFile(join(directory, 'materials.md'), materials || '本次未发送论文材料。', { mode: 0o400 });
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(request, null, 2), { mode: 0o400 });
      await chmod(directory, 0o500);
      return directory;
    },
  };
}
