import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { readPaperHistoryMessage } from './codex-runtime.mjs';
import { CLAUDE_WEB_TOOLS, checkClaudeHelp, checkClaudeInit } from './agent-selfcheck.mjs';

export const runtimeError = (message, code = 'agent_failed') => Object.assign(new Error(message), { code });
const stopped = () => runtimeError('生成已停止。', 'stopped');
const MAX_OUTPUT = 8_000_000;
const SESSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const status = (value) => ({ ...value, capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } });
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const EFFORT = /^[a-z][a-z0-9_-]{0,39}$/;
// Read-only network tools: they reach the web through Anthropic's servers and never touch local files or commands.
const WEB_TOOLS = CLAUDE_WEB_TOOLS.join(',');
const INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'read-paper-models', request: { subtype: 'initialize' } })}\n`;

/** The CLI's own model menu (the one `/model` shows), read through its SDK handshake; no prompt is sent. */
function nativeModels(output) {
  for (const line of output.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const models = event?.type === 'control_response' && event.response?.request_id === 'read-paper-models' ? event.response.response?.models : undefined;
    if (!Array.isArray(models)) continue;
    return models.filter(model => typeof model?.value === 'string' && MODEL_ID.test(model.value) && typeof model.displayName === 'string').slice(0, 30).map(model => ({
      id: model.value, name: model.displayName.slice(0, 80), isDefault: model.value === 'default',
      ...(typeof model.description === 'string' ? { description: model.description.slice(0, 300) } : {}),
      efforts: model.supportsEffort && Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter(effort => typeof effort === 'string' && EFFORT.test(effort)).slice(0, 10) : [],
    }));
  }
  return [];
}

// Cancellation targets this CLI process group; never a user's shared daemon.
export function runNativeProcess({ executable, args, cwd, env, input = '', signal, spawnImpl = spawn, timeoutMs = 180_000, killAfterMs = 750, onLine }) {
  if (signal?.aborted) return Promise.reject(stopped());
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(executable, args, { cwd, env: { ...env, ...(cwd ? { PWD: cwd } : {}) }, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(runtimeError('无法启动本机 Agent。', error.code === 'ENOENT' ? 'not-installed' : 'agent_failed')); return; }
    let output = '';
    let buffer = '';
    let stderr = '';
    let failure;
    let killTimer;
    const sendSignal = (name) => {
      try {
        if (process.platform !== 'win32' && Number.isInteger(child.pid)) process.kill(-child.pid, name);
        else child.kill(name);
      } catch { try { child.kill(name); } catch {} }
    };
    const stop = (error) => {
      if (failure) return;
      failure = error;
      sendSignal('SIGTERM');
      killTimer = setTimeout(() => sendSignal('SIGKILL'), killAfterMs);
      killTimer.unref?.();
    };
    const abort = () => stop(stopped());
    const timer = setTimeout(() => stop(runtimeError('Agent 响应超时，请重试或检查本机配置。', 'timeout')), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (failure) return;
      output += chunk;
      if (output.length > MAX_OUTPUT) { stop(runtimeError('Agent 输出超过大小限制。', 'output_limit')); return; }
      if (!onLine) return;
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { onLine(line); }
        catch (error) { stop(error.code ? error : runtimeError('Agent 返回了无效事件。', 'protocol_error')); return; }
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { failure ||= runtimeError('无法启动本机 Agent。', error.code === 'ENOENT' ? 'not-installed' : 'agent_failed'); });
    child.on('close', (code) => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (!failure && onLine && buffer.trim()) {
        try { onLine(buffer.trim()); } catch (error) { failure = error.code ? error : runtimeError('Agent 返回了无效事件。', 'protocol_error'); }
      }
      failure ? reject(failure) : resolve({ output, stderr, code });
    });
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}

function executablePath(env) {
  const local = join(homedir(), '.local', 'node', 'bin', 'claude');
  return env.CLAUDE_BIN || (existsSync(local) ? local : 'claude');
}

export async function projectDirectory(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0')) throw runtimeError('研究目录无效。', 'invalid_project');
  try {
    const directory = await realpath(cwd);
    if (!(await stat(directory)).isDirectory()) throw new Error();
    return directory;
  } catch { throw runtimeError('研究目录不可访问，请重新连接目录。', 'project_unavailable'); }
}

const CLAUDE_READ_ONLY = 'Claude Code 未提供可原子核验的跨客户端会话占用锁；此原生记录只读。请先在原生应用中继续。';

async function claudeProjectPath(cwd, env) {
  const directory = await projectDirectory(cwd);
  const name = env.CLAUDE_CONFIG_DIR && /^[\w-]{1,64}$/.test(env.CLAUDE_CODE_PROJECT_DIR_NAME || '')
    ? env.CLAUDE_CODE_PROJECT_DIR_NAME : directory.replace(/[^a-zA-Z0-9]/g, '-');
  // shortcut: long native directory hashes are version-specific; add SDK discovery before supporting these paths.
  if (name.length > 200) throw runtimeError('此目录对应的 Claude Code 历史使用版本相关的长路径索引，当前不能安全发现。', 'history_unsupported');
  const path = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', name);
  try { if (!(await lstat(path)).isDirectory()) throw new Error(); }
  catch (error) { if (error.code !== 'ENOENT') throw runtimeError('Claude Code 项目历史目录不可读取。', 'history_unavailable'); }
  return { directory, path };
}

async function claudeTranscript({ cwd, path, sessionId, signal }) {
  if (!SESSION.test(sessionId || '')) throw runtimeError('Claude Code 会话标识无效。', 'invalid_session');
  if (signal?.aborted) throw stopped();
  let file;
  try { file = await open(join(path, `${sessionId}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw runtimeError('Claude Code 会话记录不可读取。', 'history_unavailable'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_OUTPUT) throw runtimeError('Claude Code 会话记录过大或格式不支持。', 'history_unsupported');
    const bytes = Buffer.alloc(MAX_OUTPUT + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_OUTPUT) throw runtimeError('Claude Code 会话记录超过读取限制。', 'history_unsupported');
    const contents = bytes.toString('utf8', 0, size);
    if (signal?.aborted) throw stopped();
    const rows = contents.split('\n');
    const messages = new Map();
    const directories = new Map();
    let matched = false, title, truncated = false;
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].trim()) continue;
      let entry;
      try { entry = JSON.parse(rows[i]); }
      catch {
        if (i === rows.length - 1) { truncated = true; continue; }
        throw runtimeError('Claude Code 会话记录损坏，原始文件已保留。', 'history_unavailable');
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (entry.sessionId && entry.sessionId !== sessionId) throw runtimeError('Claude Code 会话记录身份不匹配。', 'invalid_session');
      if (typeof entry.cwd === 'string') {
        let nativeCwd;
        try {
          if (!directories.has(entry.cwd)) directories.set(entry.cwd, await realpath(entry.cwd));
          nativeCwd = directories.get(entry.cwd);
        } catch { throw runtimeError('Claude Code 会话的研究目录不可核验。', 'invalid_session'); }
        if (nativeCwd !== cwd) throw runtimeError('此 Claude Code 会话不属于当前研究目录。', 'invalid_session');
        matched = true;
      }
      if (typeof entry.customTitle === 'string') title = entry.customTitle;
      if (entry.isSidechain || !['user', 'assistant'].includes(entry.type) || typeof entry.uuid !== 'string' || entry.uuid.length > 200) continue;
      const content = entry.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : part?.type === 'thinking' ? '' : '[附件或工具记录未展开]').filter(Boolean).join('\n') : '';
      if (!text) continue;
      const message = readPaperHistoryMessage({ role: entry.type, text });
      messages.set(entry.uuid, { ...message, id: entry.uuid, text: message.text.slice(0, 100_000),
        ...(typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp)) ? { createdAt: new Date(entry.timestamp).toISOString() } : {}) });
      if (message.text.length > 100_000) truncated = true;
    }
    if (!matched) throw runtimeError('无法确认此 Claude Code 会话所属目录。', 'invalid_session');
    const all = [...messages.values()];
    const prompt = all.find(message => message.role === 'user')?.text || '';
    title ||= (prompt.startsWith('[Read-paper requestId=') ? prompt.split('用户本次问题：').slice(1).join('用户本次问题：').trim() : prompt).split('\n')[0] || 'Claude Code 对话';
    let budget = 1_000_000;
    const visible = [];
    for (const message of all.slice(-500)) {
      if (budget <= 0) { truncated = true; break; }
      if (message.text.length > budget) truncated = true;
      visible.push({ ...message, text: message.text.slice(0, budget) }); budget -= message.text.length;
    }
    return { id: sessionId, title: title.slice(0, 160), updatedAt: info.mtime.toISOString(), state: 'unknown', canResume: false, reason: CLAUDE_READ_ONLY,
      messages: visible, ...(truncated || all.length > 500 ? { truncated: true } : {}) };
  } finally { await file.close(); }
}

export function createClaudeRuntime({ executable, spawnImpl = spawn, env = process.env, timeoutMs = 180_000, killAfterMs = 750 } = {}) {
  executable ||= executablePath(env);
  const invoke = (args, options = {}) => runNativeProcess({ executable, spawnImpl, env, timeoutMs, killAfterMs, args, ...options });
  let permissionPrompts, effortFlag, modelFlag, webFlag, planMode;
  async function applyActivity(sessions, cwd, signal) {
    try {
      const response = await invoke(['agents', '--json', '--cwd', cwd], { cwd, signal, timeoutMs: 10_000 });
      const active = JSON.parse(response.output);
      if (response.code !== 0 || !Array.isArray(active) || active.length > 1000) return;
      const busy = new Set();
      for (const item of active) {
        if (!SESSION.test(item.sessionId || '') || typeof item.cwd !== 'string' || (!['busy', 'waiting'].includes(item.status) && !['working', 'blocked'].includes(item.state))) continue;
        if (await realpath(item.cwd).catch(() => undefined) === cwd) busy.add(item.sessionId);
      }
      for (const session of sessions) if (busy.has(session.id)) { session.state = 'busy'; session.reason = '正在 Claude Code 原生应用中运行或等待输入，当前仅可查看记录。'; }
    } catch (error) { if (signal?.aborted) throw stopped(); }
  }
  return {
    async listSessions({ cwd, signal } = {}) {
      const project = await claudeProjectPath(cwd, env);
      let files;
      try { files = await readdir(project.path, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return { sessions: [], detail: CLAUDE_READ_ONLY }; throw runtimeError('Claude Code 项目历史不可读取。', 'history_unavailable'); }
      const candidates = [];
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !SESSION.test(entry.name.slice(0, -6))) continue;
        const info = await lstat(join(project.path, entry.name)).catch(() => undefined);
        if (info?.isFile()) candidates.push({ id: entry.name.slice(0, -6), updated: info.mtimeMs });
      }
      const sessions = [];
      let skipped = 0;
      for (const entry of candidates.sort((a, b) => b.updated - a.updated).slice(0, 100)) {
        try { const { messages, truncated, ...session } = await claudeTranscript({ cwd: project.directory, path: project.path, sessionId: entry.id, signal }); sessions.push(session); }
        catch (error) { if (error.code === 'stopped') throw error; skipped++; }
      }
      if (sessions.length) await applyActivity(sessions, project.directory, signal);
      return { sessions, detail: `${CLAUDE_READ_ONLY}${skipped ? ` ${skipped} 条记录无法安全核验，未显示。` : ''}${candidates.length > 100 ? ' 当前显示最近 100 条记录。' : ''}` };
    },
    async readSession({ cwd, sessionId, signal } = {}) {
      const project = await claudeProjectPath(cwd, env);
      const session = await claudeTranscript({ cwd: project.directory, path: project.path, sessionId, signal });
      await applyActivity([session], project.directory, signal);
      return session;
    },
    async probe({ signal } = {}) {
      let version;
      try {
        const installed = await invoke(['--version'], { signal, timeoutMs: 10_000 });
        if (installed.code !== 0) throw runtimeError('Claude Code 版本检测失败。');
        version = installed.output.trim().slice(0, 100);
        const help = await invoke(['--help'], { signal, timeoutMs: 10_000 });
        const check = checkClaudeHelp(help.output);
        if (help.code !== 0 || check.missing.length) {
          return status({ state: 'error', version, detail: `此 Claude Code（${version}）缺少运行所需参数 ${check.missing.join(' ') || '--help'}。版本较旧请升级；若已是新版本，说明参数有变，需要更新本应用的适配。` });
        }
        // Some releases dropped --permission-prompts; with every tool disabled in --print mode it is only a belt-and-braces flag.
        ({ permissionPrompts, effort: effortFlag, model: modelFlag, web: webFlag, plan: planMode } = check.flags);
        const auth = await invoke(['auth', 'status', '--json'], { signal, timeoutMs: 10_000 });
        if (JSON.parse(auth.output).loggedIn !== true) return status({ state: 'needs-auth', version, detail: '请在本机终端完成 claude auth login 后重新检测；平台不会读取或代管登录凭据。' });
        const menu = await invoke(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { signal, timeoutMs: 10_000, input: INITIALIZE }).catch(() => undefined);
        const models = menu && modelFlag ? nativeModels(menu.output).map(model => effortFlag ? model : { ...model, efforts: [] }) : [];
        const warnings = [...check.warnings, ...(modelFlag && !models.length ? ['读不到 Claude Code 的模型菜单（握手格式可能已变）：模型按钮已隐藏，按 CLI 默认模型运行。'] : [])];
        return status({ state: 'ready', version, models, web: webFlag, plan: planMode, selfCheck: { checked: check.checked + 1, warnings },
          detail: '使用本机认证，仅处理显式提供的文字；工具、MCP、插件、交互权限和图片均未开放。' });
      } catch (error) {
        return status({ state: error.code === 'not-installed' ? 'not-installed' : 'error', ...(version ? { version } : {}), detail: error.code === 'not-installed' ? '未安装 Claude Code CLI。' : '无法检测 Claude Code，请检查本机 CLI 配置后重试。' });
      }
    },
    /** `web` opens only WebSearch/WebFetch; `plan` uses the CLI's own plan mode. Everything else stays text-only. */
    async run({ prompt, cwd, nativeSessionId, model: chosenModel, effort, plan = false, web = false, signal, onEvent = () => {} }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2_000_000) throw runtimeError('发送给 Claude Code 的文字无效。', 'invalid_input');
      if (nativeSessionId && !SESSION.test(nativeSessionId)) throw runtimeError('Claude Code 会话标识无效。', 'invalid_session');
      if (chosenModel !== undefined && (typeof chosenModel !== 'string' || !MODEL_ID.test(chosenModel))) throw runtimeError('Claude Code 模型选择无效。', 'invalid_model');
      if (effort !== undefined && (typeof effort !== 'string' || !EFFORT.test(effort) || effortFlag === false)) throw runtimeError('此 Claude Code 版本不支持所选思考程度。', 'invalid_effort');
      if (chosenModel !== undefined && chosenModel !== 'default' && modelFlag === false) throw runtimeError('此 Claude Code 版本不支持选择模型。', 'invalid_model');
      if (web && webFlag === false) throw runtimeError('此 Claude Code 版本不能只放行联网工具，联网检索已关闭。', 'invalid_input');
      if (plan && planMode === false) throw runtimeError('此 Claude Code 版本不再提供 plan 模式。', 'invalid_input');
      let sessionId = nativeSessionId;
      let announcedSession = false;
      let body = '';
      let streamed = '';
      let model;
      let result;
      // Safe mode and an explicit tool list keep the boundary: no files, commands, MCP or plugins; web tools only when asked for.
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--disable-slash-commands', '--tools', web ? WEB_TOOLS : '', ...(web ? ['--allowedTools', WEB_TOOLS] : []), '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', plan ? 'plan' : 'dontAsk', ...(permissionPrompts === false ? [] : ['--permission-prompts', 'none'])];
      if (chosenModel && chosenModel !== 'default') args.push('--model', chosenModel);
      if (effort) args.push('--effort', effort);
      if (nativeSessionId) args.push('--resume', nativeSessionId);
      const response = await invoke(args, { cwd, input: prompt, signal, onLine(line) {
        const event = JSON.parse(line);
        if (event.session_id) {
          if (!SESSION.test(event.session_id) || (sessionId && event.session_id !== sessionId)) throw runtimeError('Claude Code 返回了不匹配的原生会话。', 'protocol_error');
          sessionId = event.session_id;
          if (!announcedSession) { announcedSession = true; onEvent({ type: 'session', nativeSessionId: sessionId }); }
        }
        if (event.type === 'system' && event.subtype === 'init') {
          model = event.model;
          // The init event lists what this run really opened; anything beyond the request stops the run before a model answers.
          const opened = checkClaudeInit(event, { web, plan });
          if (opened.extra.length) throw runtimeError(`Claude Code 实际开放了未请求的能力（${opened.extra.join('、')}），已停止本轮以保持隔离；多半是新版本改了参数，需要更新本应用的适配。`, 'isolation_failed');
          for (const text of opened.warnings) onEvent({ type: 'progress', kind: 'compat', text });
          onEvent({ type: 'progress', kind: 'status', text: 'Claude Code 正在阅读已发送的文字' });
        } else if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
          const text = event.event.delta.text;
          if (typeof text === 'string') { streamed += text; onEvent({ type: 'delta', text }); }
        } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
          const content = Array.isArray(event.message?.content) ? event.message.content : [];
          for (const part of content) {
            if (part?.type !== 'tool_use' || !['WebSearch', 'WebFetch'].includes(part.name)) continue;
            const target = part.name === 'WebSearch' ? part.input?.query : part.input?.url;
            if (typeof target === 'string' && target.trim()) onEvent({ type: 'progress', kind: 'web', text: `${part.name === 'WebSearch' ? '联网检索' : '读取网页'}：${target.trim().slice(0, 300)}` });
          }
          body = content.filter((part) => part.type === 'text').map((part) => part.text).join('');
        } else if (event.type === 'system' && event.subtype === 'permission_denied') {
          onEvent({ type: 'progress', kind: 'permission', text: 'Claude Code 的工具或交互请求已拒绝；当前仅支持文字问答。' });
        } else if (event.type === 'result') result = event;
      } });
      if (response.code !== 0 || result?.is_error) throw Object.assign(runtimeError('Claude Code 运行失败，请检查本机登录、额度或配置后重试。', /auth|login|401|403/i.test(response.stderr + JSON.stringify(result || {})) ? 'needs-auth' : 'agent_failed'),
        { detail: `${response.stderr}\n${typeof result?.result === 'string' ? result.result : ''}`.trim().slice(-1200) });
      if (!result || result.subtype !== 'success') throw runtimeError('Claude Code 回答中断，已保留收到的内容。', 'stream_interrupted');
      body = typeof result.result === 'string' ? result.result : body || streamed;
      if (!body.trim() || !sessionId) throw runtimeError('Claude Code 没有返回完整的可见回答或会话标识。', 'protocol_error');
      if (!streamed) onEvent({ type: 'delta', text: body });
      return { body, nativeSessionId: sessionId, ...(model ? { model } : {}) };
    },
  };
}
