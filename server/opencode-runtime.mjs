import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNativeProcess, runtimeError } from './claude-runtime.mjs';

const AGENT = 'read-paper';
const DENY_TOOLS = [{ action: '*', resource: '*', effect: 'deny' }];
const CONFIG = JSON.stringify({
  permissions: DENY_TOOLS,
  agents: { [AGENT]: { description: 'Answer only the supplied research text. No tools.', mode: 'primary', permissions: DENY_TOOLS } },
  update: 'disable', share: 'disabled', snapshots: false,
  plugins: ['-opencode.tool.*', '-opencode.tools', '-opencode.config.compatibility', '-opencode.config.instruction', '-opencode.config.mcp'],
});
const MODEL = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+(?:#[a-zA-Z0-9._-]+)?$/;
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
        requireIsolatedConfig();
        if (!model || !MODEL.test(model)) return status({ state: 'error', version, detail: '请在本地服务配置 OPENCODE_MODEL=供应商/模型；不会自动使用免费模型或替换供应商。' });
        const auth = await invoke(['auth', 'list'], { timeoutMs: 10_000 });
        const provider = model.split('/')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
        const credential = auth.output.split('\n').some((line) => /stored|environment|api.?key/i.test(line) && line.replace(/[^a-z0-9]/gi, '').toLowerCase().includes(provider));
        if (auth.code !== 0 || !credential) return status({ state: 'needs-auth', version, detail: '未检测到所选模型供应商的本机 OpenCode 凭据，请在终端完成 opencode auth login 后重新检测。' });
        return status({ state: 'ready', version, detail: `已检测本机凭据；使用 ${model}，实际请求仍可能受额度或网络影响。仅支持显式文字，工具与图片未开放。` });
      } catch (error) {
        return status({ state: error.code === 'not-installed' ? 'not-installed' : 'error', ...(version ? { version } : {}), detail: error.code === 'not-installed' ? '未安装 OpenCode CLI。' : error.code === 'sandbox_unavailable' ? error.message : '无法检测 OpenCode，请检查本机 CLI 配置后重试。' });
      }
    },
    async run({ prompt, cwd, nativeSessionId, signal, onEvent = () => {} }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2_000_000) throw runtimeError('发送给 OpenCode 的文字无效。', 'invalid_input');
      if (!model || !MODEL.test(model)) throw runtimeError('请先在本地服务配置 OPENCODE_MODEL=供应商/模型。', 'model_required');
      if (nativeSessionId && !/^ses_[a-zA-Z0-9]{1,100}$/.test(nativeSessionId)) throw runtimeError('OpenCode 会话标识无效。', 'invalid_session');
      requireIsolatedConfig();
      const configDir = await mkdtemp(join(tmpdir(), 'read-paper-opencode-config-'));
      let sessionId = nativeSessionId;
      let announcedSession = false;
      let body = '';
      let completed = false;
      let failed;
      const seenParts = new Set();
      const args = ['run', '--standalone', '--format', 'json', '--agent', AGENT, '--model', model];
      if (nativeSessionId) args.push('--session', nativeSessionId);
      try {
        const response = await invoke(args, {
          cwd, input: prompt, signal,
          // Isolate config discovery while retaining the CLI's own credential and session store.
          env: { ...env, OPENCODE_CONFIG: '', OPENCODE_CONFIG_DIR: configDir, OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_CONFIG_CONTENT: CONFIG },
          onLine(line) {
            const event = JSON.parse(line);
            if (event.sessionID) {
              if (!/^ses_[a-zA-Z0-9]{1,100}$/.test(event.sessionID) || (sessionId && event.sessionID !== sessionId)) throw runtimeError('OpenCode 返回了不匹配的原生会话。', 'protocol_error');
              sessionId = event.sessionID;
              if (!announcedSession) { announcedSession = true; onEvent({ type: 'session', nativeSessionId: sessionId }); }
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
        return { body, nativeSessionId: sessionId, model };
      } finally { await rm(configDir, { recursive: true, force: true }); }
    },
  };
}
