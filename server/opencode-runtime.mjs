import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirectory, runNativeProcess, runtimeError } from './claude-runtime.mjs';
import { readPaperHistoryMessage } from './codex-runtime.mjs';

const AGENT = 'read-paper';
const DENY_TOOLS = [{ action: '*', resource: '*', effect: 'deny' }];
const CONFIG = {
  permissions: DENY_TOOLS,
  agents: { [AGENT]: { description: 'Answer only the supplied research text. No tools.', mode: 'primary', permissions: DENY_TOOLS } },
  update: 'disable', share: 'disabled', snapshots: false,
  plugins: ['-opencode.tool.*', '-opencode.tools', '-opencode.config.compatibility', '-opencode.config.instruction', '-opencode.config.mcp'],
};
const MODEL = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+(?:#[a-zA-Z0-9._-]+)?$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validModel = value => typeof value === 'string' && value.length <= 200 && MODEL.test(value);
const validSession = value => typeof value === 'string' && /^ses_[a-zA-Z0-9]{1,100}$/.test(value);
const EXTERNAL_READ_ONLY = '共享服务可显示运行状态，但无法排除其他独立进程的占用；外部 OpenCode 会话当前只读，可在原生应用中继续。';
const isoTime = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : undefined;
function modelValue(value) {
  if (typeof value === 'string') return value.trim();
  if (record(value) && typeof value.providerID === 'string' && typeof value.model === 'string')
    return `${value.providerID}/${value.model}${value.variant && value.variant !== 'default' ? `#${value.variant}` : ''}`;
}
function mergeConfig(base, patch) {
  const result = new Map(Object.entries(base));
  for (const [key, value] of Object.entries(patch))
    result.set(key, record(value) && record(result.get(key)) ? mergeConfig(result.get(key), value) : value);
  return Object.fromEntries(result);
}
const status = (value) => ({ ...value, capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } });

function requireIsolatedConfig() {
  const managed = process.platform === 'darwin'
    ? ['/Library/Application Support/opencode', '/Library/Managed Preferences/ai.opencode.managed.plist', join('/Library/Managed Preferences', homedir().split('/').at(-1), 'ai.opencode.managed.plist')]
    : process.platform === 'win32' ? [join(process.env.ProgramData || 'C:\\ProgramData', 'opencode')] : ['/etc/opencode'];
  if (managed.some((path) => existsSync(path))) throw runtimeError('检测到可能覆盖只读限制的 OpenCode 托管配置，当前连接不能安全启用。', 'sandbox_unavailable');
}

export function createOpenCodeRuntime({ executable, spawnImpl = spawn, env = process.env, model = env.OPENCODE_MODEL, timeoutMs = 180_000, killAfterMs = 750 } = {}) {
  const local = join(homedir(), '.opencode', 'bin', 'opencode');
  executable ||= env.OPENCODE_BIN || (existsSync(local) ? local : 'opencode');
  const invoke = (args, options = {}) => runNativeProcess({ executable, spawnImpl, env, timeoutMs, killAfterMs, args, ...options });
  async function nativeApi(method, path, { cwd, signal, body } = {}) {
    const args = ['api', method, path];
    if (body) args.push('--data', JSON.stringify(body));
    const response = await invoke(args, { cwd, signal, timeoutMs: 15_000 });
    try {
      const result = JSON.parse(response.output);
      if (response.code !== 0 || !record(result) || (result.data === undefined && typeof result.interrupted !== 'boolean')) throw new Error();
      return result;
    } catch { throw runtimeError('OpenCode 原生项目记录不可读取，请检查共享服务或版本后重试。', 'history_unavailable'); }
  }
  async function belongs(info, directory) {
    if (!record(info) || !validSession(info.id) || typeof info.location?.directory !== 'string') return false;
    try { return await realpath(info.location.directory) === directory; } catch { return false; }
  }
  async function activeSessions(cwd, signal) {
    try {
      const { data } = await nativeApi('GET', '/api/session/active', { cwd, signal });
      return record(data) ? data : undefined;
    } catch (error) { if (signal?.aborted) throw error; return undefined; }
  }
  function summary(info, active) {
    const busy = active && Object.hasOwn(active, info.id);
    const time = info.time?.updated ?? info.time?.created;
    return { id: info.id, title: typeof info.title === 'string' && info.title ? info.title.slice(0, 160) : 'OpenCode 对话',
      updatedAt: isoTime(time) || new Date(0).toISOString(),
      state: busy ? 'busy' : 'unknown', canResume: false,
      reason: busy ? '正在 OpenCode 原生应用中运行，完成后可刷新查看。' : EXTERNAL_READ_ONLY };
  }
  async function getProjectSession(cwd, sessionId, signal) {
    if (!validSession(sessionId)) throw runtimeError('OpenCode 会话标识无效。', 'invalid_session');
    const { data } = await nativeApi('GET', `/api/session/${sessionId}`, { cwd, signal });
    if (data.id !== sessionId || !await belongs(data, cwd)) throw runtimeError('此 OpenCode 会话不属于当前研究目录。', 'invalid_session');
    return data;
  }
  async function nativeCompletion(cwd, sessionId, messageId, text, startedAt, signal) {
    try {
      const info = await getProjectSession(cwd, sessionId, signal);
      if (info.outcome !== 'succeeded' || !Number.isFinite(info.time?.idle)) return false;
      const { data } = await nativeApi('GET', `/api/session/${sessionId}/message/${messageId}`, { cwd, signal });
      if (!record(data) || data.id !== messageId || data.type !== 'assistant' || data.finish !== 'stop'
        || !Number.isFinite(data.time?.created) || data.time.created < startedAt
        || !Number.isFinite(data.time?.completed) || data.time.completed < data.time.created || data.time.completed > info.time.idle
        || !Array.isArray(data.content) || data.content.some(part => !record(part) || !['text', 'reasoning'].includes(part.type) || (part.type === 'text' && typeof part.text !== 'string'))) return false;
      return data.content.filter(part => part.type === 'text').map(part => part.text).join('') === text;
    } catch (error) { if (signal?.aborted) throw error; return false; }
  }
  async function connection(signal, resumeModel, resuming = false) {
    const override = typeof model === 'string' ? model.trim() : model;
    if (override && !validModel(override)) throw runtimeError('OPENCODE_MODEL 格式无效，请使用供应商/模型，或留空沿用 OpenCode 配置。', 'model_required');
    requireIsolatedConfig();
    // The private native API resolves config without debug redaction; never log its contents.
    const discovered = await invoke(['api', '--standalone', 'GET', '/api/config'], { cwd: homedir(), signal, timeoutMs: 10_000,
      env: { ...env, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' } });
    let sources;
    try {
      sources = JSON.parse(discovered.output);
      if (discovered.code !== 0 || !Array.isArray(sources)) throw new Error('invalid config');
    } catch { throw runtimeError('无法读取 OpenCode 本机配置，请检查本机配置后重新连接。', 'config_unavailable'); }
    let providers = {}, configured;
    for (const source of sources) {
      if (!record(source) || source.type !== 'document' || !record(source.info)) continue;
      if (record(source.info.providers)) providers = mergeConfig(providers, source.info.providers);
      if (source.info.model !== undefined) configured = modelValue(source.info.model);
    }
    // Existing native sessions retain their original model even if the TUI's recent choice changes.
    if (resuming) return { providers, model: validModel(resumeModel) ? resumeModel : undefined };
    let selected = override || configured;
    if (!selected) {
      const paths = await invoke(['debug', 'paths'], { signal, timeoutMs: 10_000 });
      const statePath = paths.code === 0 && /^state\s+(.+)$/m.exec(paths.output)?.[1]?.trim();
      if (statePath) {
        try {
          const saved = JSON.parse(await readFile(join(statePath, 'model.json'), 'utf8'));
          const recent = Array.isArray(saved.recent) && saved.recent.find(item => record(item) && typeof item.providerID === 'string' && typeof item.modelID === 'string' && validModel(`${item.providerID}/${item.modelID}`));
          if (recent) {
            selected = `${recent.providerID}/${recent.modelID}`;
            const variant = saved.variant?.[selected];
            if (variant && variant !== 'default') selected += `#${variant}`;
          }
        } catch (error) { if (error.code !== 'ENOENT') throw runtimeError('无法读取 OpenCode 最近模型，请在 OpenCode 中重新选择模型后重试。', 'config_unavailable'); }
      }
    }
    if (!validModel(selected)) throw runtimeError('未找到 OpenCode 已选模型。请先在 OpenCode 中选择模型，或用 OPENCODE_MODEL 显式指定。', 'model_required');
    return { providers, model: selected };
  }
  return {
    async listSessions({ cwd, signal } = {}) {
      const directory = await projectDirectory(cwd);
      // The v2 CLI only applies these filters when they are in the URL, not --param with METHOD/path.
      const result = await nativeApi('GET', `/api/session?${new URLSearchParams({ directory, limit: '100', order: 'desc' })}`, { cwd: directory, signal });
      if (!Array.isArray(result.data) || result.data.length > 100) throw runtimeError('OpenCode 会话列表协议不兼容。', 'protocol_error');
      const active = await activeSessions(directory, signal);
      const sessions = [];
      for (const info of result.data) if (await belongs(info, directory)) sessions.push(summary(info, active));
      return { sessions, ...(typeof result.cursor?.next === 'string' ? { nextCursor: result.cursor.next } : {}), detail: EXTERNAL_READ_ONLY };
    },
    async readSession({ cwd, sessionId, signal } = {}) {
      const directory = await projectDirectory(cwd);
      const info = await getProjectSession(directory, sessionId, signal);
      const rows = [];
      let cursor, truncated = false;
      for (let page = 0; page < 5; page++) {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : { order: 'desc' }) });
        const result = await nativeApi('GET', `/api/session/${sessionId}/message?${query}`, { cwd: directory, signal });
        if (!Array.isArray(result.data) || result.data.length > 100) throw runtimeError('OpenCode 历史协议不兼容。', 'protocol_error');
        rows.push(...result.data);
        cursor = typeof result.cursor?.next === 'string' ? result.cursor.next : undefined;
        if (!cursor) break;
        if (page === 4) truncated = true;
      }
      const messages = new Map();
      let budget = 1_000_000;
      for (const entry of rows.reverse()) {
        if (!record(entry) || !['user', 'assistant'].includes(entry.type) || typeof entry.id !== 'string' || entry.id.length > 200) continue;
        const parts = Array.isArray(entry.content) ? entry.content : [];
        const text = typeof entry.text === 'string' ? entry.text : parts.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : part?.type === 'reasoning' ? '' : '[附件或工具记录未展开]').filter(Boolean).join('\n');
        if (!text) continue;
        if (budget <= 0) { truncated = true; break; }
        const message = readPaperHistoryMessage({ role: entry.type, text });
        const visible = message.text.slice(0, Math.min(100_000, budget)); budget -= visible.length;
        if (visible.length < message.text.length) truncated = true;
        messages.set(entry.id, { ...message, id: entry.id, text: visible,
          ...(isoTime(entry.time?.created) ? { createdAt: isoTime(entry.time.created) } : {}) });
      }
      const active = await activeSessions(directory, signal);
      return { ...summary(info, active), messages: [...messages.values()], ...(truncated ? { truncated: true } : {}) };
    },
    async probe({ signal } = {}) {
      let version;
      try {
        const installed = await invoke(['--version'], { signal, timeoutMs: 10_000 });
        if (installed.code !== 0) throw runtimeError('OpenCode 版本检测失败。');
        version = installed.output.trim().slice(0, 100);
        if (!/\bv?2\./.test(version)) return status({ state: 'error', version, detail: '当前适配器已验证 OpenCode v2 原生协议；请安装 v2 后重新检测。' });
        const help = await invoke(['run', '--help'], { signal, timeoutMs: 10_000 });
        if (help.code !== 0 || ['--standalone', '--format', '--session', '--agent', '--model'].some((flag) => !help.output.includes(flag))) return status({ state: 'error', version, detail: '此 OpenCode 版本缺少独占服务或会话参数，请升级后重新检测。' });
        const selected = await connection(signal);
        return status({ state: 'ready', version, detail: `新对话使用本机 OpenCode 模型 ${selected.model}；认证与额度由实际请求确认。仅支持显式文字，工具与图片未开放。` });
      } catch (error) {
        return status({ state: error.code === 'not-installed' ? 'not-installed' : 'error', ...(version ? { version } : {}), detail: error.code === 'not-installed' ? '未安装 OpenCode CLI。' : ['sandbox_unavailable', 'model_required', 'config_unavailable'].includes(error.code) ? error.message : '无法检测 OpenCode，请检查本机 CLI 配置后重试。' });
      }
    },
    async run({ prompt, title, cwd, materialCwd, nativeSessionId, nativeModel, signal, onEvent = () => {} }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2_000_000) throw runtimeError('发送给 OpenCode 的文字无效。', 'invalid_input');
      if (nativeSessionId && !/^ses_[a-zA-Z0-9]{1,100}$/.test(nativeSessionId)) throw runtimeError('OpenCode 会话标识无效。', 'invalid_session');
      const selected = await connection(signal, nativeModel, Boolean(nativeSessionId));
      let announcedSession = false;
      if (materialCwd) {
        cwd = await projectDirectory(cwd);
        if (nativeSessionId) {
          const existing = await getProjectSession(cwd, nativeSessionId, signal);
          if (JSON.stringify(existing.permissions) !== JSON.stringify(DENY_TOOLS)) throw runtimeError('此 OpenCode 会话未使用当前连接的只读权限；请在原生应用中继续。', 'permission_error');
        } else {
          const created = await nativeApi('POST', '/api/session', { cwd, signal, body: { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 160) : 'Read-paper 研究对话', location: { directory: cwd }, permissions: DENY_TOOLS } });
          if (!await belongs(created.data, cwd) || JSON.stringify(created.data.permissions) !== JSON.stringify(DENY_TOOLS)) throw runtimeError('OpenCode 未建立符合研究目录与只读权限的会话。', 'protocol_error');
          nativeSessionId = created.data.id;
          announcedSession = true;
          onEvent({ type: 'session', nativeSessionId, ...(selected.model ? { model: selected.model } : {}) });
        }
        const active = await activeSessions(cwd, signal);
        if (!active) throw runtimeError('无法核验 OpenCode 共享服务的运行状态，请稍后重试。', 'session_state_unknown');
        if (Object.hasOwn(active, nativeSessionId)) throw runtimeError('此会话正在 OpenCode 原生应用中运行，请完成后再继续。', 'session_busy');
      }
      const configDir = await mkdtemp(join(tmpdir(), 'read-paper-opencode-config-'));
      let sessionId = nativeSessionId;
      let body = '';
      let completed = false;
      let finishReceived = false;
      let failed;
      const seenParts = new Set();
      const messageIds = new Set();
      let unboundText = false;
      const args = materialCwd ? ['run', '--format', 'json'] : ['run', '--standalone', '--format', 'json', '--agent', AGENT];
      if (selected.model) args.push('--model', selected.model);
      if (nativeSessionId) args.push('--session', nativeSessionId);
      try {
        const startedAt = Date.now();
        const response = await invoke(args, {
          cwd, input: prompt, signal,
          // Isolate config discovery while retaining the CLI's own credential and session store.
          env: { ...env, OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...CONFIG, providers: selected.providers }) },
          onLine(line) {
            const event = JSON.parse(line);
            if (event.sessionID) {
              if (!/^ses_[a-zA-Z0-9]{1,100}$/.test(event.sessionID) || (sessionId && event.sessionID !== sessionId)) throw runtimeError('OpenCode 返回了不匹配的原生会话。', 'protocol_error');
              sessionId = event.sessionID;
              if (!announcedSession) { announcedSession = true; onEvent({ type: 'session', nativeSessionId: sessionId, ...(selected.model ? { model: selected.model } : {}) }); }
            }
            if (['text', 'step_start', 'step_finish'].includes(event.type) && /^msg_[a-zA-Z0-9]{1,100}$/.test(event.part?.messageID || '')) messageIds.add(event.part.messageID);
            if (event.type === 'text' && typeof event.part?.text === 'string' && !seenParts.has(event.part.id)) {
              if (!/^msg_[a-zA-Z0-9]{1,100}$/.test(event.part.messageID || '')) unboundText = true;
              if (event.part.id) seenParts.add(event.part.id);
              body += event.part.text;
              onEvent({ type: 'delta', text: event.part.text });
            } else if (event.type === 'step_start') {
              completed = false;
              onEvent({ type: 'progress', kind: 'status', text: 'OpenCode 正在阅读已发送的文字' });
            } else if (event.type === 'tool_use') {
              onEvent({ type: 'progress', kind: 'permission', text: 'OpenCode 工具请求已拒绝；当前连接仅支持文字问答。' });
              if (event.part?.state?.status === 'completed') failed = runtimeError('OpenCode 执行了未开放的工具，已中止连接。', 'permission_error');
              if (failed) throw failed;
            } else if (event.type === 'error') {
              failed = event.error?.type === 'provider.rate-limit' || event.error?.status === 429
                ? runtimeError('OpenCode 供应商限制了请求频率或额度，请稍后重试。', 'rate_limited')
                : runtimeError('OpenCode 运行失败，请检查所选模型的登录、额度或网络后重试。', /auth|401|403/i.test(JSON.stringify(event.error)) ? 'needs-auth' : 'agent_failed');
            } else if (event.type === 'step_finish') { finishReceived = true; completed = event.part?.reason === 'stop'; }
          },
        });
        if (failed) throw failed;
        if (response.code !== 0) throw runtimeError('OpenCode 进程退出，请检查本机 CLI 配置后重试。');
        // v2 can backfill text after session.wait without draining step_finish; verify this turn, never an older answer.
        if (!completed && !finishReceived && materialCwd && sessionId && body.trim() && !unboundText && messageIds.size === 1)
          completed = await nativeCompletion(cwd, sessionId, [...messageIds][0], body, startedAt, signal);
        if (!completed || !body.trim() || !sessionId) throw runtimeError('OpenCode 回答中断，已保留收到的内容。', 'stream_interrupted');
        return { body, nativeSessionId: sessionId, ...(selected.model ? { model: selected.model } : {}) };
      } catch (error) {
        if (materialCwd && ['stopped', 'timeout', 'protocol_error', 'permission_error', 'output_limit'].includes(error.code)) {
          try {
            // A shared run outlives its CLI; stop only the session this invocation actually started.
            const response = await invoke(['api', 'POST', `/api/session/${nativeSessionId}/interrupt?resume=false`], { cwd, timeoutMs: 5000 });
            if (response.code !== 0 || typeof JSON.parse(response.output).interrupted !== 'boolean') throw new Error();
            const active = await activeSessions(cwd);
            if (!active || Object.hasOwn(active, nativeSessionId)) throw new Error();
          } catch { throw runtimeError('OpenCode 本轮停止状态尚未确认；请先在原生应用核对记录，再决定是否重发。', 'stop_unconfirmed'); }
        }
        throw error;
      } finally { await rm(configDir, { recursive: true, force: true }); }
    },
  };
}
