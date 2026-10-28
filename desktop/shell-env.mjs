import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { delimiter, isAbsolute } from 'node:path';

// A Finder/Dock launch skips shell startup files, so proxies, provider endpoints and keys that make
// `codex` / `claude` / `opencode` work in a terminal are missing. Only names those CLIs read are imported.
export const IMPORTED_NAMES = /^(?:PATH|https?_proxy|HTTPS?_PROXY|all_proxy|ALL_PROXY|no_proxy|NO_PROXY|(?:ANTHROPIC|OPENAI|AZURE_OPENAI|CODEX|CLAUDE|OPENCODE|OPENROUTER|DEEPSEEK|GEMINI|MOONSHOT|DASHSCOPE|ZHIPU)_\w+|AWS_(?:PROFILE|REGION|DEFAULT_REGION|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK)|GOOGLE_(?:API_KEY|APPLICATION_CREDENTIALS|CLOUD_PROJECT)|CLOUD_ML_REGION|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME)$/;
const LAUNCHD_NAMES = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

const run = (execFileImpl, file, args, options) => new Promise((resolve, reject) => {
  execFileImpl(file, args, options, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});

/** Parses `env -0` output written between two markers, ignoring anything startup files print. */
export function parseEnvironment(output, marker) {
  const start = output.indexOf(marker), end = output.lastIndexOf(marker);
  if (start < 0 || end <= start) return undefined;
  const values = {};
  for (const entry of output.slice(start + marker.length, end).split('\0')) {
    const split = entry.indexOf('=');
    if (split > 0) values[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return values;
}

async function readLoginShell({ env, platform, execFileImpl, timeoutMs }) {
  const shell = env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  const marker = `__PAPERTRAIL_ENV_${randomUUID().replace(/-/g, '')}__`;
  const output = await run(execFileImpl, shell, ['-ilc', `printf '%s' '${marker}'; command env -0; printf '%s' '${marker}'`], {
    env: { ...env, PAPERTRAIL_RESOLVING_ENVIRONMENT: '1' }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
  });
  return parseEnvironment(output, marker);
}

async function readLaunchd({ execFileImpl }) {
  const values = {};
  await Promise.all(LAUNCHD_NAMES.map(async name => {
    try { const value = (await run(execFileImpl, '/bin/launchctl', ['getenv', name], { timeout: 2000, encoding: 'utf8' })).trim(); if (value) values[name] = value; }
    catch { /* Unset names are expected. */ }
  }));
  return values;
}

/**
 * Reads the user's login-shell environment once per launch. On macOS, variables set with `launchctl setenv`
 * are merged too (the shell's values win), because GUI apps launched earlier never received them.
 */
export async function importLoginEnvironment({ env = process.env, platform = process.platform, execFileImpl = execFile, timeoutMs = 8000 } = {}) {
  if (platform === 'win32') return { source: 'process', values: {} };
  const [shell, launchd] = await Promise.all([
    readLoginShell({ env, platform, execFileImpl, timeoutMs }).catch(() => undefined), // A slow or failing profile must not block agents.
    platform === 'darwin' ? readLaunchd({ execFileImpl }) : {},
  ]);
  const sources = [shell && Object.keys(shell).length && 'login-shell', Object.keys(launchd).length && 'launchd'].filter(Boolean);
  return { source: sources.join('+') || 'none', values: { ...launchd, ...(shell || {}) } };
}

/**
 * Adds only names the launch environment does not define at all, so an explicit value (even an empty one
 * that deliberately clears a key) wins. PATH keeps the launch order and appends the shell's entries.
 */
export function mergeAgentEnvironment(base, imported = {}) {
  const env = { ...base }, added = [];
  for (const [name, value] of Object.entries(imported)) {
    if (name === 'PATH' || !IMPORTED_NAMES.test(name) || typeof value !== 'string' || !value || value.includes('\0')) continue;
    if (env[name] === undefined) { env[name] = value; added.push(name); }
  }
  const paths = [...(base.PATH || '').split(delimiter), ...(imported.PATH || '').split(delimiter)].filter(Boolean);
  env.PATH = [...new Set(paths)].join(delimiter);
  return { env, added: added.sort() };
}
