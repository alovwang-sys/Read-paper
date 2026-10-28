import test from 'node:test';
import assert from 'node:assert/strict';
import { importLoginEnvironment, mergeAgentEnvironment, parseEnvironment } from './shell-env.mjs';

const fakeExec = ({ shell, launchd = {} }) => (file, args, options, callback) => {
  if (file === '/bin/launchctl') {
    const value = launchd[args[1]];
    queueMicrotask(() => value ? callback(null, `${value}\n`) : callback(Object.assign(new Error('unset'), { code: 1 }), ''));
    return;
  }
  const marker = args[1].match(/'(__PAPERTRAIL_ENV_\w+__)'/)[1];
  assert.equal(options.env.PAPERTRAIL_RESOLVING_ENVIRONMENT, '1');
  queueMicrotask(() => shell instanceof Error ? callback(shell, '') : callback(null, `profile noise\n${marker}${Object.entries(shell).map(([k, v]) => `${k}=${v}`).join('\0')}\0${marker}trailing`));
};

test('parses env -0 output between markers and ignores profile noise', () => {
  assert.deepEqual(parseEnvironment('noise MARKA=1\0B=x=y\0MARK tail', 'MARK'), { A: '1', B: 'x=y' });
  assert.equal(parseEnvironment('no markers here', 'MARK'), undefined);
});

test('imports the login shell and launchd on macOS, with the shell winning', async () => {
  const result = await importLoginEnvironment({ env: { SHELL: '/bin/zsh' }, platform: 'darwin', execFileImpl: fakeExec({
    shell: { PATH: '/Users/u/.local/bin:/usr/bin', https_proxy: 'http://127.0.0.1:7890', OPENAI_API_KEY: 'shell-key' },
    launchd: { ANTHROPIC_BASE_URL: 'https://relay.example', OPENAI_API_KEY: 'launchd-key' },
  }) });
  assert.equal(result.source, 'login-shell+launchd');
  assert.equal(result.values.https_proxy, 'http://127.0.0.1:7890');
  assert.equal(result.values.ANTHROPIC_BASE_URL, 'https://relay.example');
  assert.equal(result.values.OPENAI_API_KEY, 'shell-key');
});

test('a failing profile falls back to launchd, and Windows keeps the process environment', async () => {
  const failed = await importLoginEnvironment({ env: {}, platform: 'darwin', execFileImpl: fakeExec({ shell: new Error('timeout'), launchd: { HTTPS_PROXY: 'http://proxy' } }) });
  assert.deepEqual(failed, { source: 'launchd', values: { HTTPS_PROXY: 'http://proxy' } });
  assert.deepEqual(await importLoginEnvironment({ platform: 'win32', execFileImpl: () => assert.fail() }), { source: 'process', values: {} });
});

test('merge adds only agent-relevant names that the launch environment does not define', () => {
  const { env, added } = mergeAgentEnvironment(
    { PATH: '/usr/bin:/bin', OPENAI_API_KEY: '', HOME: '/Users/u' },
    { PATH: '/Users/u/.local/bin:/usr/bin', https_proxy: 'http://p', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'k', SECRET_UNRELATED: 's', HOME: '/elsewhere' },
  );
  assert.equal(env.PATH, '/usr/bin:/bin:/Users/u/.local/bin');
  assert.equal(env.https_proxy, 'http://p');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 't');
  assert.equal(env.OPENAI_API_KEY, '', 'an explicitly cleared key stays cleared');
  assert.equal(env.SECRET_UNRELATED, undefined);
  assert.equal(env.HOME, '/Users/u');
  assert.deepEqual(added, ['ANTHROPIC_AUTH_TOKEN', 'https_proxy']);
});
