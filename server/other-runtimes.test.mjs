import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { createClaudeRuntime, runNativeProcess } from './claude-runtime.mjs';
import { createOpenCodeRuntime } from './opencode-runtime.mjs';

const uuid = 'b70f0269-c566-4cd2-a423-04c7a2f0229f';
const sid = 'ses_testSession123';
const model = 'zhipuai-coding-plan/glm-5.3-flash';
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const claudeHelp = '--safe-mode --restricted --tools --strict-mcp-config --permission-prompts --include-partial-messages';
const opencodeHelp = '--standalone --format --session --agent --model';

function fakeProcesses(scripts) {
  const calls = [];
  function spawnImpl(executable, args, options) {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signals: [] });
    const call = { executable, args, options, child, input: '' };
    calls.push(call);
    child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
    child.kill = (signal) => {
      child.signals.push(signal);
      if (!call.ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
      return true;
    };
    const script = scripts.shift();
    assert.ok(script, 'unexpected process');
    queueMicrotask(() => {
      if (typeof script === 'function') { script(call); return; }
      if (script.error) { child.emit('error', Object.assign(new Error('secret diagnostic'), { code: script.error })); child.emit('close', null); return; }
      const bytes = Buffer.from(script.output || '');
      // Exercise StringDecoder with UTF-8 split inside multibyte characters.
      for (let offset = 0; offset < bytes.length; offset += 2) child.stdout.write(bytes.subarray(offset, offset + 2));
      child.stderr.write(script.stderr || '');
      child.stdout.end(); child.stderr.end(); child.exitCode = script.code || 0;
      child.emit('close', child.exitCode);
    });
    return child;
  }
  return { calls, spawnImpl };
}

test('Claude readiness requires installed safety flags and native authentication', async () => {
  for (const [scripts, state] of [
    [[{ error: 'ENOENT' }], 'not-installed'],
    [[{ output: '2.1.0' }, { output: '--tools' }], 'error'],
    [[{ output: '2.1.281' }, { output: claudeHelp }, { output: '{"loggedIn":false}', code: 1 }], 'needs-auth'],
    [[{ output: '2.1.281' }, { output: claudeHelp }, { output: '{"loggedIn":true}' }], 'ready'],
  ]) {
    const fake = fakeProcesses(scripts);
    assert.equal((await createClaudeRuntime({ spawnImpl: fake.spawnImpl }).probe()).state, state);
    assert.ok(fake.calls.every((call) => call.options.shell === false));
  }
});

test('Claude parses only visible text and resumes real session using fixed safe arguments and stdin', async () => {
  const events = [];
  const fake = fakeProcesses([{ output: jsonl(
    { type: 'system', subtype: 'init', session_id: uuid, model: 'claude-sonnet' },
    { type: 'stream_event', event: { delta: { type: 'thinking_delta', thinking: 'private reasoning' } } },
    { type: 'stream_event', event: { delta: { type: 'text_delta', text: '中文🦉' } } },
    { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '中文🦉' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '中文🦉', session_id: uuid },
  ) }]);
  const prompt = '--dangerously-skip-permissions $(touch forbidden)\nread this quote';
  const result = await createClaudeRuntime({ spawnImpl: fake.spawnImpl }).run({ prompt, cwd: '/tmp/supplied-materials', nativeSessionId: uuid, onEvent: (event) => events.push(event) });
  assert.deepEqual(result, { body: '中文🦉', nativeSessionId: uuid, model: 'claude-sonnet' });
  assert.deepEqual(events.filter((event) => event.type === 'delta'), [{ type: 'delta', text: '中文🦉' }]);
  assert.equal(JSON.stringify(events).includes('private reasoning'), false);
  const call = fake.calls[0];
  assert.equal(call.input, prompt);
  assert.equal(call.args.includes(prompt), false);
  assert.equal(call.options.env.PWD, '/tmp/supplied-materials');
  assert.ok(call.args.includes('--safe-mode') && call.args.includes('--restricted'));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(call.args[call.args.indexOf('--resume') + 1], uuid);
  assert.equal(call.args.includes('--dangerously-skip-permissions'), false);
});

test('Claude final result supplies a delta when partial messages are unavailable', async () => {
  const fake = fakeProcesses([{ output: jsonl({ type: 'result', subtype: 'success', result: 'answer', session_id: uuid }) }]);
  const events = [];
  assert.equal((await createClaudeRuntime({ spawnImpl: fake.spawnImpl }).run({ prompt: 'hello', onEvent: (event) => events.push(event) })).body, 'answer');
  assert.deepEqual(events, [{ type: 'session', nativeSessionId: uuid }, { type: 'delta', text: 'answer' }]);
});

test('Claude rejects malformed, truncated, empty and failed responses without diagnostic secrets', async () => {
  for (const script of [
    { output: 'not-json' },
    { output: jsonl({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }) },
    { output: jsonl({ type: 'result', subtype: 'success', result: '', session_id: uuid }) },
    { output: jsonl({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['secret-token-123'] }), code: 1, stderr: 'secret-token-123' },
  ]) {
    const fake = fakeProcesses([script]);
    await assert.rejects(createClaudeRuntime({ spawnImpl: fake.spawnImpl }).run({ prompt: 'hello' }), (error) => Boolean(error.code) && !error.message.includes('secret-token-123'));
  }
});

test('OpenCode requires explicit model, compatible CLI and matching native credential', async () => {
  for (const [version, configuredModel, auth, state] of [
    ['opencode v1.2.0', model, '', 'error'],
    ['opencode v2.0.18', undefined, '', 'error'],
    ['opencode v2.0.18', model, 'No stored credentials', 'needs-auth'],
    ['opencode v2.0.18', model, 'OpenAI stored', 'needs-auth'],
    ['opencode v2.0.18', model, 'Zhipu AI Coding Plan  stored', 'ready'],
  ]) {
    const scripts = [{ output: version }];
    if (version.includes('v2.')) scripts.push({ output: opencodeHelp });
    if (version.includes('v2.') && configuredModel) scripts.push({ output: auth });
    const fake = fakeProcesses(scripts);
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {}, model: configuredModel }).probe();
    assert.equal(result.state, state);
  }
});

test('OpenCode uses its own server, denies tools, deduplicates text, ignores reasoning and preserves native session', async () => {
  const fake = fakeProcesses([{ output: jsonl(
    { type: 'step_start', sessionID: sid, part: { id: 'step' } },
    { type: 'reasoning', sessionID: sid, part: { text: 'private reasoning' } },
    { type: 'text', sessionID: sid, part: { id: 'text-1', text: '原生回答🦉' } },
    { type: 'text', sessionID: sid, part: { id: 'text-1', text: '原生回答🦉' } },
    { type: 'step_finish', sessionID: sid, part: { reason: 'stop' } },
  ) }]);
  const events = [];
  const runtime = createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: { PWD: '/wrong' }, model });
  const result = await runtime.run({ prompt: 'quote', cwd: '/tmp/materials', onEvent: (event) => events.push(event) });
  assert.deepEqual(result, { body: '原生回答🦉', nativeSessionId: sid, model });
  assert.equal(events[0].type, 'session');
  assert.deepEqual(events.filter((event) => event.type === 'delta'), [{ type: 'delta', text: '原生回答🦉' }]);
  const call = fake.calls[0];
  assert.equal(call.input, 'quote');
  assert.ok(call.args.includes('--standalone') && !call.args.includes('--auto'));
  assert.equal(call.options.env.PWD, '/tmp/materials');
  assert.equal(call.options.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  const config = JSON.parse(call.options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.agents['read-paper'].permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.ok(config.plugins.includes('-opencode.tool.*'));
  assert.equal(existsSync(call.options.env.OPENCODE_CONFIG_DIR), false, 'temporary config is removed');
});

test('OpenCode resume uses native --session and does not pretend that incomplete output succeeded', async () => {
  const fake = fakeProcesses([{ output: jsonl({ type: 'text', sessionID: sid, part: { id: 'text-1', text: 'partial' } }) }]);
  await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, model }).run({ prompt: 'follow up', nativeSessionId: sid }), (error) => error.code === 'stream_interrupted');
  assert.equal(fake.calls[0].args[fake.calls[0].args.indexOf('--session') + 1], sid);
});

test('OpenCode rejects actual tool execution and redacts upstream failures', async () => {
  for (const [event, code] of [
    [{ type: 'tool_use', sessionID: sid, part: { state: { status: 'completed' } } }, 'permission_error'],
    [{ type: 'error', sessionID: sid, error: { type: 'provider.auth', message: 'secret-token-123' } }, 'needs-auth'],
    [{ type: 'error', sessionID: sid, error: { type: 'provider.rate-limit', status: 429, message: 'secret-token-123' } }, 'rate_limited'],
  ]) {
    const fake = fakeProcesses([{ output: jsonl(event) }]);
    await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, model }).run({ prompt: 'hi' }), (error) => error.code === code && !error.message.includes('secret-token-123'));
    assert.equal(existsSync(fake.calls[0].options.env.OPENCODE_CONFIG_DIR), false);
  }
});

test('untrusted session identifiers are rejected before spawning', async () => {
  for (const runtime of [createClaudeRuntime({ spawnImpl: () => assert.fail('must not spawn') }), createOpenCodeRuntime({ model, spawnImpl: () => assert.fail('must not spawn') })]) {
    await assert.rejects(runtime.run({ prompt: 'hello', nativeSessionId: '--auto' }), (error) => error.code === 'invalid_session');
  }
});

test('native resume rejects changed session identifiers instead of silently starting another session', async () => {
  const claude = fakeProcesses([{ output: jsonl({ type: 'system', subtype: 'init', session_id: '103242d1-5a9c-4bdc-a986-34973cf2e0f4' }) }]);
  await assert.rejects(createClaudeRuntime({ spawnImpl: claude.spawnImpl }).run({ prompt: 'follow up', nativeSessionId: uuid }), (error) => error.code === 'protocol_error');
  const opencode = fakeProcesses([{ output: jsonl({ type: 'step_start', sessionID: 'ses_otherSession' }) }]);
  await assert.rejects(createOpenCodeRuntime({ spawnImpl: opencode.spawnImpl, model }).run({ prompt: 'follow up', nativeSessionId: sid }), (error) => error.code === 'protocol_error');
});

test('native cancellation waits for child close, escalates to kill and releases listeners', async () => {
  const controller = new AbortController();
  const fake = fakeProcesses([(call) => { call.ignoreTerm = true; setTimeout(() => controller.abort(), 5); }]);
  const keepingTestAlive = setTimeout(() => assert.fail('cancellation hung'), 1000);
  try {
    await assert.rejects(runNativeProcess({ executable: 'fake', args: [], env: {}, spawnImpl: fake.spawnImpl, signal: controller.signal, killAfterMs: 10 }), (error) => error.code === 'stopped');
    assert.deepEqual(fake.calls[0].child.signals, ['SIGTERM', 'SIGKILL']);
  } finally { clearTimeout(keepingTestAlive); }
  controller.abort();
  assert.equal(fake.calls[0].child.signals.length, 2);
});

test('already cancelled calls never spawn and native timeouts stop children', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runNativeProcess({ executable: 'fake', args: [], signal: controller.signal, spawnImpl: () => assert.fail('must not spawn') }), (error) => error.code === 'stopped');
  const fake = fakeProcesses([() => {}]);
  const keepingTestAlive = setTimeout(() => assert.fail('timeout hung'), 1000);
  try {
    await assert.rejects(runNativeProcess({ executable: 'fake', args: [], env: {}, spawnImpl: fake.spawnImpl, timeoutMs: 5 }), (error) => error.code === 'timeout');
    assert.deepEqual(fake.calls[0].child.signals, ['SIGTERM']);
  } finally { clearTimeout(keepingTestAlive); }
});
