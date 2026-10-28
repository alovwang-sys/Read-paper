import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

// Only variable names are reported; values (proxy hosts, keys, relay URLs) never leave the local service.
const PROXY_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'];
const PROVIDER_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CONFIG_DIR', 'OPENCODE_CONFIG'];
const LABELS = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode', model: '模型直连', demo: '演示模式' };
const LOGIN = { codex: 'codex login', claude: 'claude auth login', opencode: 'opencode auth login' };

const short = path => { const home = homedir(); return path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path; };
const executable = path => access(path, constants.X_OK).then(() => true, () => false);
const version = (path, env) => new Promise(resolve => {
  execFile(path, ['--version'], { env, timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? undefined : String(stdout).trim().split('\n')[0].slice(0, 80)));
});

/** Mirrors each runtime's own lookup: explicit override, its private install, then PATH order. */
function lookup(id, env) {
  const name = process.platform === 'win32' ? `${id}.exe` : id;
  const override = { codex: env.CODEX_BIN, claude: env.CLAUDE_BIN, opencode: env.OPENCODE_BIN }[id];
  const preferred = { claude: join(homedir(), '.local', 'node', 'bin', 'claude'), opencode: join(homedir(), '.opencode', 'bin', 'opencode') }[id];
  const onPath = (env.PATH || '').split(delimiter).filter(dir => dir && isAbsolute(dir)).map(dir => join(dir, name));
  return { override: override && isAbsolute(override) ? override : undefined, candidates: [...new Set([preferred, ...onPath].filter(Boolean))] };
}

export async function diagnoseAgents(env, ids = ['codex', 'claude', 'opencode']) {
  const agents = await Promise.all(ids.map(async id => {
    const { override, candidates } = lookup(id, env);
    const found = [];
    for (const path of override ? [override, ...candidates] : candidates) if (!found.includes(path) && await executable(path)) found.push(path);
    const installs = await Promise.all(found.slice(0, 4).map(async path => ({ path: short(path), version: await version(path, env) })));
    return { id, used: installs[0], others: installs.slice(1) };
  }));
  let shellEnv;
  try { shellEnv = JSON.parse(env.PAPERTRAIL_AGENT_ENV || 'null'); } catch { shellEnv = null; }
  return {
    agents,
    environment: {
      source: typeof shellEnv?.source === 'string' ? shellEnv.source : 'process',
      imported: Array.isArray(shellEnv?.imported) ? shellEnv.imported.filter(name => typeof name === 'string').slice(0, 40) : [],
      proxy: PROXY_NAMES.filter(name => env[name]),
      provider: PROVIDER_NAMES.filter(name => env[name]),
    },
  };
}

/** Turns runtime failures into a category and a next step a person can act on. Text is matched, never echoed raw. */
export function classifyAgentFailure(id, { code, message = '', detail = '' } = {}) {
  // The CLI's own output decides; the adapter's generic wording ("检查登录、额度或配置") would match everything.
  const text = `${code || ''} ${detail || message}`;
  const label = LABELS[id] || '助手';
  if (code === 'not-installed' || /ENOENT|not[- ]installed|command not found|未安装|无法启动本机 Agent/i.test(text))
    return { kind: 'not-installed', hint: `应用没有找到 ${label} 命令。终端里能用时，通常是命令装在只有 shell 配置才加入 PATH 的目录；应用已读取登录 shell 的 PATH，仍找不到请重启应用。` };
  if (code === 'needs-auth' || /\b401\b|\b403\b|unauthori[sz]ed|not logged in|logged ?out|invalid api key|authentication|需登录|登录/i.test(text))
    return { kind: 'auth', hint: `${label} 需要登录或凭据已失效。请在终端运行 ${LOGIN[id] || '对应的登录命令'}；应用沿用 CLI 自己的登录，不保存凭据。` };
  if (/\b429\b|rate.?limit|quota|usage limit|insufficient|额度|并发受限/i.test(text))
    return { kind: 'quota', hint: `${label} 的额度或并发已用尽，稍后再试，或改用其他已就绪的助手。` };
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|stream disconnected|error sending request|proxy|tls|certificate|fetch failed|socket|connection (?:error|refused|reset)|网络|代理/i.test(text))
    return { kind: 'network', hint: `${label} 连不上服务。终端能用而应用不行，多半是终端里的代理变量（https_proxy 等）没有传给应用；应用已自动从登录 shell 导入，修改后需重启应用。` };
  if (code === 'timeout' || /timed? ?out|超时/i.test(text))
    return { kind: 'timeout', hint: `${label} 长时间没有返回。可能是网络慢或任务过大，可稍后重试或缩小范围。` };
  if (code === 'sandbox_unavailable' || /upgrade|升级|版本|缺少|不能隔离|v2/i.test(text))
    return { kind: 'version', hint: `${label} 版本与应用适配要求不符。注意应用调用的可能不是终端里那一份：请对照下方“实际调用”的路径与版本。` };
  return { kind: 'unknown', hint: `${label} 返回了未识别的错误。可在终端用同一命令确认，或改用其他已就绪的助手。` };
}

/** Hides secret-looking values before a CLI's own error text is shown in the app. */
export function redactSecrets(text, env = {}) {
  let result = String(text || '');
  const secrets = Object.entries(env).filter(([name, value]) => /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(name) && typeof value === 'string' && value.length >= 6).map(([, value]) => value);
  for (const secret of secrets.sort((a, b) => b.length - a.length)) result = result.split(secret).join('[已隐藏]');
  return result
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, '[已隐藏]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[已隐藏]')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[已隐藏]@')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .trim().slice(-400);
}
