import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const runtimeError = (message, code = 'agent_failed') => Object.assign(new Error(message), { code });
const stopped = () => runtimeError('生成已停止。', 'stopped');
const MAX_OUTPUT = 8_000_000;
const SESSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const status = (value) => ({ ...value, capabilities: { images: false, tools: false, resume: true, permissions: 'read-only' } });

// Both CLIs own their process group. No shell, shared daemon, or raw stderr reaches the browser.
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

export function createClaudeRuntime({ executable, spawnImpl = spawn, env = process.env, timeoutMs = 180_000, killAfterMs = 750 } = {}) {
  executable ||= executablePath(env);
  const invoke = (args, options = {}) => runNativeProcess({ executable, spawnImpl, env, timeoutMs, killAfterMs, args, ...options });
  return {
    async probe() {
      let version;
      try {
        const installed = await invoke(['--version'], { timeoutMs: 10_000 });
        if (installed.code !== 0) throw runtimeError('Claude Code 版本检测失败。');
        version = installed.output.trim().slice(0, 100);
        const help = await invoke(['--help'], { timeoutMs: 10_000 });
        if (help.code !== 0 || ['--safe-mode', '--restricted', '--tools', '--strict-mcp-config', '--permission-prompts', '--include-partial-messages'].some((flag) => !help.output.includes(flag))) {
          return status({ state: 'error', version, detail: '此 Claude Code 版本缺少安全隔离或流式协议参数，请升级后重新检测。' });
        }
        const auth = await invoke(['auth', 'status', '--json'], { timeoutMs: 10_000 });
        if (JSON.parse(auth.output).loggedIn !== true) return status({ state: 'needs-auth', version, detail: '请在本机终端完成 claude auth login 后重新检测；平台不会读取或代管登录凭据。' });
        return status({ state: 'ready', version, detail: '使用本机认证，仅处理显式提供的文字；工具、MCP、插件、交互权限和图片均未开放。' });
      } catch (error) {
        return status({ state: error.code === 'not-installed' ? 'not-installed' : 'error', ...(version ? { version } : {}), detail: error.code === 'not-installed' ? '未安装 Claude Code CLI。' : '无法检测 Claude Code，请检查本机 CLI 配置后重试。' });
      }
    },
    async run({ prompt, cwd, nativeSessionId, signal, onEvent = () => {} }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2_000_000) throw runtimeError('发送给 Claude Code 的文字无效。', 'invalid_input');
      if (nativeSessionId && !SESSION.test(nativeSessionId)) throw runtimeError('Claude Code 会话标识无效。', 'invalid_session');
      let sessionId = nativeSessionId;
      let announcedSession = false;
      let body = '';
      let streamed = '';
      let model;
      let result;
      const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--safe-mode', '--restricted', '--disable-slash-commands', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
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
          onEvent({ type: 'progress', kind: 'status', text: 'Claude Code 正在阅读已发送的文字' });
        } else if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
          const text = event.event.delta.text;
          if (typeof text === 'string') { streamed += text; onEvent({ type: 'delta', text }); }
        } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
          body = (event.message?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('');
        } else if (event.type === 'system' && event.subtype === 'permission_denied') {
          onEvent({ type: 'progress', kind: 'permission', text: 'Claude Code 的工具或交互请求已拒绝；当前仅支持文字问答。' });
        } else if (event.type === 'result') result = event;
      } });
      if (response.code !== 0 || result?.is_error) throw runtimeError('Claude Code 运行失败，请检查本机登录、额度或配置后重试。', /auth|login|401|403/i.test(response.stderr + JSON.stringify(result || {})) ? 'needs-auth' : 'agent_failed');
      if (!result || result.subtype !== 'success') throw runtimeError('Claude Code 回答中断，已保留收到的内容。', 'stream_interrupted');
      body = typeof result.result === 'string' ? result.result : body || streamed;
      if (!body.trim() || !sessionId) throw runtimeError('Claude Code 没有返回完整的可见回答或会话标识。', 'protocol_error');
      if (!streamed) onEvent({ type: 'delta', text: body });
      return { body, nativeSessionId: sessionId, ...(model ? { model } : {}) };
    },
  };
}
