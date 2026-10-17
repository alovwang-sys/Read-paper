import { mkdir, readFile, writeFile, rename, realpath, lstat, readdir, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, parse } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { sanitizeAgentProgress } from './codex-runtime.mjs';
import { imageRequestManifest, writeRegionImages } from './images.mjs';

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
const present = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const creationUnknown = () => fail(409, 'creation_unconfirmed', '目录可能已创建，但尚不能核实完整关联。请保留当前表单并检查目录，不要重复创建或删除其中内容。');

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
  const queryLifecycle = new AbortController();
  const queries = new Set();
  const ready = (async () => {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try {
      registry = JSON.parse(await readFile(registryPath, 'utf8'));
      if (registry.version !== 1 || !object(registry.bindings) || !object(registry.sessions) || registry.operations !== undefined && !object(registry.operations)) throw new Error();
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail(500, 'project_read_failed', '无法读取研究目录关联；已有记录未覆盖。');
      registry = { version: 1, bindings: {}, sessions: {} };
    }
  })();
  ready.catch(() => {});
  const save = () => { writes = writes.catch(() => {}).then(() => atomicJSON(registryPath, registry)); return writes; };
  async function nativeQuery(adapter, method, input) {
    if (queryLifecycle.signal.aborted) throw fail(503, 'service_stopped', '本机助手服务已停止。');
    const controller = new AbortController();
    const signal = AbortSignal.any([queryLifecycle.signal, controller.signal]);
    const task = Promise.resolve().then(() => adapter[method]({ ...input, signal }));
    queries.add(task);
    task.then(() => queries.delete(task), () => queries.delete(task));
    let timer;
    let cancel;
    try {
      return await Promise.race([task, new Promise((_, reject) => {
        cancel = () => reject(queryLifecycle.signal.aborted ? fail(503, 'service_stopped', '本机助手服务已停止。') : fail(504, 'history_timeout', '读取原生记录超时，已保留上次内容，请稍后刷新。'));
        signal.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => controller.abort(), queryTimeoutMs);
        if (signal.aborted) cancel();
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }

  async function canonical(path, allowNew = false, browsing = false, newIntent = false) {
    if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(path)) throw fail(400, 'invalid_directory', '请选择有效的绝对目录。');
    let actual;
    try { actual = await realpath(path); }
    catch (error) {
      if (!allowNew || error.code !== 'ENOENT' || !basename(path) || ['.', '..'].includes(basename(path))) throw fail(400, 'directory_unavailable', '目录不存在或无法访问，请重新选择。');
      try { actual = join(await realpath(dirname(path)), basename(path)); } catch { throw fail(400, 'directory_unavailable', '请先选择已存在的父目录。'); }
    }
    const home = await realpath(homedir());
    if (!browsing && (actual === parse(actual).root || actual === home) || /(?:^|[\\/])(?:\.codex|\.claude|\.ssh|\.git|\.read-paper|secrets)(?:[\\/]|$)/i.test(actual)) throw fail(400, 'invalid_directory', '请选择具体研究文件夹，不能使用系统根目录、整个用户目录或配置目录。');
    try { if (!(await lstat(actual)).isDirectory()) throw fail(newIntent ? 409 : 400, newIntent ? 'directory_exists' : 'invalid_directory', newIntent ? '此位置已存在同名文件，请更改名称或位置。' : '所选位置不是可用目录。'); }
    catch (error) { if (!(allowNew && error.code === 'ENOENT')) throw error.status ? error : fail(400, 'invalid_directory', '所选位置不是可用目录。'); }
    return actual;
  }
  function intent(body) {
    identity(body);
    if (body.mode !== undefined && !['new', 'existing'].includes(body.mode) || body.operationId !== undefined && !validId(body.operationId) || body.mode !== undefined && !validId(body.operationId)) throw fail(400, 'invalid_operation', '目录创建方式或操作标识无效，请重新打开表单。');
    if (body.mode === 'new') {
      const name = typeof body.path === 'string' ? basename(body.path) : '';
      if (!name || name !== name.trim() || ['.', '..'].includes(name) || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name) > 255 || process.platform === 'win32' && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) throw fail(400, 'invalid_name', '请输入有效的目录名称，不要使用路径分隔符或系统保留名称。');
    }
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
      if (manifest.version !== 1 || !validId(manifest.projectId) || !validId(manifest.researchId) || manifest.workspaceId !== undefined && !validId(manifest.workspaceId) || manifest.operationId !== undefined && !validId(manifest.operationId)) throw new Error();
      return manifest;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw fail(400, 'invalid_project', '已有研究清单无法识别，未覆盖文件。');
    }
  }
  const sameIdentity = (item, body) => item.researchId === body.researchId && (!item.workspaceId || item.workspaceId === body.workspaceId);
  function occupied(body, path, manifest) {
    const owner = Object.entries(registry.bindings).find(([scope, item]) => scope !== key(body) && item.path === path);
    const manifestConflict = manifest && !sameIdentity(manifest, body);
    if (!owner && !manifestConflict) return;
    const error = fail(409, 'directory_in_use', '该目录已关联其他研究，请选择其他目录。');
    if (owner) {
      const [workspaceId, researchId] = JSON.parse(owner[0]);
      if (workspaceId === body.workspaceId && manifest?.workspaceId === workspaceId && manifest.researchId === researchId && manifest.projectId === owner[1].projectId) error.ownerResearchId = researchId;
    }
    throw error;
  }
  function operation(body, path) {
    const item = body.operationId && Object.hasOwn(registry.operations || {}, body.operationId) ? registry.operations[body.operationId] : undefined;
    if (item && (item.workspaceId !== body.workspaceId || item.researchId !== body.researchId || item.path !== path || item.mode !== body.mode)) throw fail(409, 'operation_mismatch', '本次创建标识已用于其他目录，请恢复原表单或重新开始。');
    return item;
  }
  const matchesOperation = (manifest, item) => manifest && item && manifest.projectId === item.projectId && manifest.workspaceId === item.manifestWorkspaceId && manifest.researchId === item.researchId && manifest.operationId === item.manifestOperationId;
  async function preview(body) {
    intent(body); await ready;
    const path = await canonical(body.path, body.mode !== 'existing', false, body.mode === 'new');
    const item = operation(body, path);
    let manifest;
    try { manifest = await projectManifest(path); }
    catch (error) { if (item && body.mode === 'new') throw creationUnknown(); throw error; }
    occupied(body, path, manifest);
    if (item && manifest && !matchesOperation(manifest, item)) throw creationUnknown();
    if (body.mode === 'new' && await present(path)) {
      if (!item) throw fail(409, 'directory_exists', '此位置已存在同名文件或文件夹，请改名，或选择使用已有目录。');
      if (!matchesOperation(manifest, item)) throw creationUnknown();
    }
    return { path, name: basename(path) };
  }
  async function binding(body) {
    identity(body); await ready;
    const item = registry.bindings[key(body)];
    if (!item || body.bindingId && body.bindingId !== item.id) throw fail(409, 'project_required', '请先为当前研究选择目录。');
    if (await canonical(item.path) !== item.path) throw fail(409, 'directory_changed', '研究目录位置已改变，请重新连接。');
    const manifest = await projectManifest(item.path);
    if (manifest?.projectId !== item.projectId || !sameIdentity(manifest, body)) throw fail(409, 'directory_changed', '研究目录标识不匹配，已有会话未改动。');
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
    async close() {
      queryLifecycle.abort();
      await Promise.allSettled([...queries, ready, writes, bindingWrites]);
    },
    binding, remember, read,
    async markUnconfirmed(project, agentId, nativeId) {
      const ref = await remember(project, agentId, nativeId, 'read-paper');
      registry.sessions[ref].stopUnconfirmed = true;
      await save();
    },
    preview,
    async defaults(body) {
      identity(body);
      let parentPath;
      try { parentPath = await canonical(join(homedir(), 'Documents'), false, true); }
      catch { parentPath = await canonical(homedir(), false, true); }
      return { parentPath };
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
      const target = await preview(body);
      const existing = registry.bindings[key(body)];
      if (existing && existing.path !== target.path) throw fail(409, 'directory_changed', '此研究已绑定另一目录。请重新定位原研究目录，不能覆盖原生会话归属。');
      let previous = await projectManifest(target.path);
      occupied(body, target.path, previous);
      let item = operation(body, target.path);
      if (body.mode !== undefined && !item) await access(body.mode === 'new' ? dirname(target.path) : target.path, constants.W_OK).catch(() => { throw fail(400, 'directory_unwritable', '所选位置不可写，请更换位置或检查权限。'); });
      if (body.operationId && !item) {
        item = { workspaceId: body.workspaceId, researchId: body.researchId, mode: body.mode, path: target.path, projectId: previous?.projectId || randomUUID(), bindingId: existing?.id || randomUUID(), manifestOperationId: previous ? previous.operationId : body.operationId, manifestWorkspaceId: previous ? previous.workspaceId : body.workspaceId, createdAt: new Date().toISOString() };
        registry.operations ??= {};
        registry.operations[body.operationId] = item;
        try { await save(); } catch { delete registry.operations[body.operationId]; throw fail(500, 'project_write_failed', '无法保存创建记录，尚未开始创建目录；请检查本机存储后重试。'); }
      }
      if (body.mode === 'new' && !previous) {
        try { await mkdir(target.path, { mode: 0o700 }); }
        catch (error) {
          if (error.code === 'EEXIST') throw creationUnknown();
          delete registry.operations[body.operationId];
          try { await save(); } catch { throw creationUnknown(); }
          throw fail(400, 'directory_unwritable', '无法在此位置创建目录，请更换位置或检查权限。');
        }
      } else if (body.mode === undefined) {
        await mkdir(target.path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      }
      try {
        if (await canonical(target.path) !== target.path) throw fail(409, 'directory_changed', '目录位置已改变，请重新选择。');
        await access(target.path, constants.W_OK).catch(() => { throw fail(400, 'directory_unwritable', '此目录不可写，不能保存研究清单；请选择可写的研究目录。'); });
        previous = await projectManifest(target.path);
        occupied(body, target.path, previous);
        if (item && previous && !matchesOperation(previous, item)) throw creationUnknown();
      } catch (error) { if (body.operationId) throw creationUnknown(); throw error; }
      const projectId = item?.projectId || previous?.projectId || randomUUID();
      try {
        const directory = await managed(target.path, true);
        if (!previous) await writeFile(join(directory, 'project.json'), JSON.stringify({ version: 1, projectId, workspaceId: body.workspaceId, researchId: body.researchId, title: target.name, createdAt: item?.createdAt || new Date().toISOString(), ...(body.operationId ? { operationId: body.operationId } : {}) }, null, 2), { mode: 0o600, flag: 'wx' });
        else if (previous.title !== target.name) await atomicJSON(join(directory, 'project.json'), { ...previous, title: target.name });
      } catch (error) { if (body.operationId) throw creationUnknown(); throw error.status ? error : fail(400, 'directory_unwritable', '无法保存研究清单；已有文件未覆盖，请检查权限后重试。'); }
      const result = { id: existing?.id || item?.bindingId || randomUUID(), projectId, path: target.path, name: target.name, researchId: body.researchId };
      registry.bindings[key(body)] = result;
      try { await save(); } catch {
        if (existing) registry.bindings[key(body)] = existing; else delete registry.bindings[key(body)];
        throw fail(500, 'binding_unconfirmed', '研究目录已保存，但本机关联尚未确认。请保留表单并重试同一次创建。');
      }
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
      await atomicJSON(join(directory, `request-${digest(request.requestId)}.json`), { version: 1, ...imageRequestManifest(request) });
    },
    async materialize(project, request) {
      const parent = join(await managed(project.path, true), 'materials');
      await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) throw fail(400, 'invalid_project', '研究材料目录不可用，未覆盖已有文件。');
      const directory = join(parent, digest(request.requestId));
      await mkdir(directory, { mode: 0o700 });
      const materials = request.context.map((item, index) => `## [${index + 1}] ${item.title}\nevidenceId: ${item.evidenceId}\ndocumentId: ${item.documentId}\ndocumentHash: ${item.documentHash}\nPDF 第 ${item.pageIndex + 1} 页\n\n${item.quote}`).join('\n\n');
      await writeFile(join(directory, 'materials.md'), materials || '本次未发送论文材料。', { mode: 0o400 });
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(imageRequestManifest(request), null, 2), { mode: 0o400 });
      await writeRegionImages(directory, request.images);
      await chmod(directory, 0o500);
      return directory;
    },
  };
}
