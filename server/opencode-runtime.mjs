import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeProcess, runtimeError } from './claude-runtime.mjs';

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
    async probe() {
      let version;
      try {
        const installed = await invoke(['--version'], { timeoutMs: 10_000 });
        if (installed.code !== 0) throw runtimeError('OpenCode 版本检测失败。');
        version = installed.output.trim().slice(0, 100);
        if (!/\bv?2\./.test(version)) return status({ state: 'error', version, detail: '当前适配器已验证 OpenCode v2 原生协议；请安装 v2 后重新检测。' });
        const help = await invoke(['run', '--help'], { timeoutMs: 10_000 });
        if (help.code !== 0 || ['--standalone', '--format', '--session', '--agent', '--model'].some((flag) => !help.output.includes(flag))) return status({ state: 'error', version, detail: '此 OpenCode 版本缺少独占服务或会话参数，请升级后重新检测。' });
        const selected = await connection();
        return status({ state: 'ready', version, detail: `新对话使用本机 OpenCode 模型 ${selected.model}；认证与额度由实际请求确认。仅支持显式文字，工具与图片未开放。` });
      } catch (error) {
        return status({ state: error.code === 'not-installed' ? 'not-installed' : 'error', ...(version ? { version } : {}), detail: error.code === 'not-installed' ? '未安装 OpenCode CLI。' : ['sandbox_unavailable', 'model_required', 'config_unavailable'].includes(error.code) ? error.message : '无法检测 OpenCode，请检查本机 CLI 配置后重试。' });
      }
    },
    async run({ prompt, cwd, nativeSessionId, nativeModel, signal, onEvent = () => {} }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2_000_000) throw runtimeError('发送给 OpenCode 的文字无效。', 'invalid_input');
      if (nativeSessionId && !/^ses_[a-zA-Z0-9]{1,100}$/.test(nativeSessionId)) throw runtimeError('OpenCode 会话标识无效。', 'invalid_session');
      const selected = await connection(signal, nativeModel, Boolean(nativeSessionId));
      const configDir = await mkdtemp(join(tmpdir(), 'read-paper-opencode-config-'));
      let sessionId = nativeSessionId;
      let announcedSession = false;
      let body = '';
      let completed = false;
      let failed;
      const seenParts = new Set();
      const args = ['run', '--standalone', '--format', 'json', '--agent', AGENT];
      if (selected.model) args.push('--model', selected.model);
      if (nativeSessionId) args.push('--session', nativeSessionId);
      try {
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
            if (event.type === 'text' && typeof event.part?.text === 'string' && !seenParts.has(event.part.id)) {
              if (event.part.id) seenParts.add(event.part.id);
              body += event.part.text;
              onEvent({ type: 'delta', text: event.part.text });
            } else if (event.type === 'step_start') {
              onEvent({ type: 'progress', kind: 'status', text: 'OpenCode 正在阅读已发送的文字' });
            } else if (event.type === 'tool_use') {
              onEvent({ type: 'progress', kind: 'permission', text: 'OpenCode 工具请求已拒绝；当前连接仅支持文字问答。' });
              if (event.part?.state?.status === 'completed') failed = runtimeError('OpenCode 执行了未开放的工具，已中止连接。', 'permission_error');
              if (failed) throw failed;
            } else if (event.type === 'error') {
              failed = event.error?.type === 'provider.rate-limit' || event.error?.status === 429
                ? runtimeError('OpenCode 供应商限制了请求频率或额度，请稍后重试。', 'rate_limited')
                : runtimeError('OpenCode 运行失败，请检查所选模型的登录、额度或网络后重试。', /auth|401|403/i.test(JSON.stringify(event.error)) ? 'needs-auth' : 'agent_failed');
            } else if (event.type === 'step_finish' && event.part?.reason === 'stop') completed = true;
          },
        });
        if (failed) throw failed;
        if (response.code !== 0) throw runtimeError('OpenCode 进程退出，请检查本机 CLI 配置后重试。');
        if (!completed || !body.trim() || !sessionId) throw runtimeError('OpenCode 回答中断，已保留收到的内容。', 'stream_interrupted');
        return { body, nativeSessionId: sessionId, ...(selected.model ? { model: selected.model } : {}) };
      } finally { await rm(configDir, { recursive: true, force: true }); }
    },
  };
}
