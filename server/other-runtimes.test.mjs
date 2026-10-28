import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeRuntime, runNativeProcess } from './claude-runtime.mjs';
import { createOpenCodeRuntime } from './opencode-runtime.mjs';

const uuid = 'b70f0269-c566-4cd2-a423-04c7a2f0229f';
const sid = 'ses_testSession123';
const model = 'zhipuai-coding-plan/glm-5.3-flash';
const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const claudeHelp = '--safe-mode --tools --strict-mcp-config --permission-mode --permission-prompts --include-partial-messages';
const opencodeHelp = '--standalone --format --session --agent --model';
const openCodeConfig = (...infos) => ({ output: JSON.stringify(infos.map((info) => ({ type: 'document', info }))) });
const openCodeAnswer = (text = 'answer') => ({ output: jsonl(
  { type: 'text', sessionID: sid, part: { id: 'answer', text } },
  { type: 'step_finish', sessionID: sid, part: { reason: 'stop' } },
) });
async function withOpenCodeState(saved, run) {
  const statePath = await mkdtemp(join(tmpdir(), 'read-paper-opencode-state-test-'));
  try {
    await writeFile(join(statePath, 'model.json'), JSON.stringify(saved));
    return await run({ output: `home /unused\nstate ${statePath}\ncache /unused\n` });
  } finally { await rm(statePath, { recursive: true, force: true }); }
}

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
      const bytes = Buffer.from((typeof script.output === 'function' ? script.output() : script.output) || '');
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

test('Claude releases without --permission-prompts stay usable and omit only that flag', async () => {
  const fake = fakeProcesses([
    { output: '2.1.239 (Claude Code)' }, { output: '--safe-mode --tools --strict-mcp-config --permission-mode --include-partial-messages' }, { output: '{"loggedIn":true}' },
    { output: jsonl({ type: 'result', subtype: 'success', result: 'answer', session_id: uuid }) },
  ]);
  const runtime = createClaudeRuntime({ spawnImpl: fake.spawnImpl });
  assert.equal((await runtime.probe()).state, 'ready');
  await runtime.run({ prompt: 'question', cwd: '/tmp/supplied-materials' });
  const run = fake.calls.at(-1);
  assert.equal(run.args.includes('--permission-prompts'), false);
  assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
  const old = fakeProcesses([{ output: '2.1.0' }, { output: '--safe-mode --tools' }]);
  assert.match((await createClaudeRuntime({ spawnImpl: old.spawnImpl }).probe()).detail, /2\.1\.0.*--strict-mcp-config/);
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
  assert.ok(call.args.includes('--safe-mode'));
  assert.equal(call.args.includes('--restricted'), false, 'native connection/model settings must remain available');
  assert.ok(call.args.includes('--disable-slash-commands'));
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(call.args[call.args.indexOf('--permission-prompts') + 1], 'none');
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

test('OpenCode readiness checks its protocol and accepts local providers without stored credentials', async () => {
  for (const [version, help, configuredModel, state] of [
    ['opencode v1.2.0', opencodeHelp, model, 'error'],
    ['opencode v2.0.18', '--format', model, 'error'],
    ['opencode v2.0.18', opencodeHelp, 'local/qwen', 'ready'],
  ]) {
    const scripts = [{ output: version }];
    if (version.includes('v2.')) scripts.push({ output: help });
    if (help === opencodeHelp && version.includes('v2.')) scripts.push(openCodeConfig({ model: configuredModel, providers: { local: { options: { baseURL: 'http://localhost:11434/v1' } } } }));
    const fake = fakeProcesses(scripts);
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).probe();
    assert.equal(result.state, state);
    assert.equal(fake.calls.some((call) => call.args[0] === 'auth'), false, 'provider auth is confirmed by the actual request, not credential-name matching');
    assert.ok(fake.calls.every((call) => call.options.shell === false));
  }
});

test('OpenCode model selection prefers explicit argument, then environment, then the last config model', async () => {
  const sources = [
    { model: 'first/old' },
    { model: { providerID: 'local', model: 'org/new:model', variant: 'high' } },
  ];
  for (const [options, expected] of [
    [{ model: 'explicit/model', env: { OPENCODE_MODEL: 'environment/model' } }, 'explicit/model'],
    [{ env: { OPENCODE_MODEL: 'environment/model' } }, 'environment/model'],
    [{ env: { OPENCODE_MODEL: '' } }, 'local/org/new:model#high'],
  ]) {
    const fake = fakeProcesses([openCodeConfig(...sources), openCodeAnswer()]);
    const events = [];
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, ...options }).run({ prompt: 'hi', onEvent: (event) => events.push(event) });
    const call = fake.calls.at(-1);
    assert.equal(call.args[call.args.indexOf('--model') + 1], expected);
    assert.equal(result.model, expected);
    assert.deepEqual(events.find((event) => event.type === 'session'), { type: 'session', nativeSessionId: sid, model: expected });
    assert.deepEqual(fake.calls[0].args, ['api', '--standalone', 'GET', '/api/config']);
    assert.equal(fake.calls[0].options.cwd, homedir(), 'config discovery does not inherit the research project');
    assert.equal(fake.calls[0].options.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.equal(fake.calls[0].options.env.OPENCODE_CONFIG_PROJECT_DISABLE, '1');
    assert.equal(fake.calls.length, 2, 'an explicit or configured model does not need the recent-model state');
  }
});

test('OpenCode inherits the recent native model and its variant when the environment is empty', async () => {
  await withOpenCodeState({
    recent: [null, { providerID: 'missing-model' }, { providerID: 'local', modelID: 'org/model:latest' }, { providerID: 'other', modelID: 'older' }],
    variant: { 'local/org/model:latest': 'high' },
  }, async (paths) => {
    const fake = fakeProcesses([openCodeConfig({}), paths, openCodeAnswer()]);
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: { OPENCODE_MODEL: '' } }).run({ prompt: 'hi' });
    assert.equal(result.model, 'local/org/model:latest#high');
    assert.deepEqual(fake.calls[1].args, ['debug', 'paths']);
    const call = fake.calls.at(-1);
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'local/org/model:latest#high');
  });
});

test('OpenCode asks for a native model selection instead of choosing an available free model', async () => {
  await withOpenCodeState({ recent: [], favorite: [{ providerID: 'opencode', modelID: 'free' }] }, async (paths) => {
    const fake = fakeProcesses([
      { output: 'opencode v2.0.18' }, { output: opencodeHelp },
      openCodeConfig({ providers: { opencode: { models: { free: { name: 'Free model' } } } } }), paths,
    ]);
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).probe();
    assert.equal(result.state, 'error');
    assert.match(result.detail, /请先在 OpenCode 中选择模型/);
    assert.equal(fake.calls.some((call) => call.args[0] === 'run' && !call.args.includes('--help')), false);
  });
});

test('OpenCode rejects invalid overrides and private config errors before starting a model without leaking diagnostics', async () => {
  const secret = 'private-config-diagnostic-secret';
  await assert.rejects(createOpenCodeRuntime({
    env: { OPENCODE_MODEL: '--unsafe' },
    spawnImpl: () => assert.fail('an invalid override must not spawn'),
  }).run({ prompt: 'hi' }), (error) => error.code === 'model_required');
  for (const script of [
    { output: JSON.stringify({ diagnostic: secret }) },
    { output: `invalid JSON ${secret}` },
    { output: '[]', code: 1, stderr: secret },
  ]) {
    const fake = fakeProcesses([script]);
    await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {}, model }).run({ prompt: 'hi' }),
      (error) => error.code === 'config_unavailable' && !error.message.includes(secret));
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0].args, ['api', '--standalone', 'GET', '/api/config']);
  }
});

test('OpenCode inherits only merged provider connections while keeping research restrictions and secrets out of events', async () => {
  const privateKey = 'test-private-provider-token';
  const fake = fakeProcesses([
    openCodeConfig({ providers: { custom: { options: { baseURL: 'https://private.example/v1', apiKey: privateKey }, models: { 'org/model': { name: 'Private model' } } } },
      permissions: [{ action: '*', effect: 'allow' }], plugins: ['unsafe-plugin'], agents: { 'read-paper': { permissions: [{ action: '*', effect: 'allow' }] } }, mcp: { unsafe: {} } },
    { model: 'custom/org/model', providers: { custom: { options: { headers: { 'X-Private': 'private-header' } } } } }),
    openCodeAnswer(),
  ]);
  const events = [];
  await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ prompt: 'hi', onEvent: (event) => events.push(event) });
  const call = fake.calls.at(-1);
  const config = JSON.parse(call.options.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(config.providers.custom, {
    options: { baseURL: 'https://private.example/v1', apiKey: privateKey, headers: { 'X-Private': 'private-header' } },
    models: { 'org/model': { name: 'Private model' } },
  });
  assert.deepEqual(config.permissions, [{ action: '*', resource: '*', effect: 'deny' }]);
  assert.deepEqual(config.agents['read-paper'].permissions, config.permissions);
  assert.equal(config.plugins.includes('unsafe-plugin'), false);
  assert.equal(config.mcp, undefined);
  assert.equal(call.options.env.OPENCODE_CONFIG, '');
  assert.equal(JSON.stringify(events).includes(privateKey), false);
  assert.equal(JSON.stringify(events).includes('private-header'), false);
  assert.equal(JSON.stringify(events).includes('private.example'), false);
});

test('OpenCode uses its own server, denies tools, deduplicates text, ignores reasoning and preserves native session', async () => {
  const fake = fakeProcesses([openCodeConfig({}), { output: jsonl(
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
  const call = fake.calls[1];
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
  const fake = fakeProcesses([openCodeConfig({}), { output: jsonl({ type: 'text', sessionID: sid, part: { id: 'text-1', text: 'partial' } }) }]);
  await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, model }).run({ prompt: 'follow up', nativeSessionId: sid }), (error) => error.code === 'stream_interrupted');
  const call = fake.calls[1];
  assert.equal(call.args[call.args.indexOf('--session') + 1], sid);
  assert.equal(call.args.includes('--model'), false, 'legacy sessions preserve the model in the native session');
});

test('OpenCode v2 reconciles a missing step_finish only against the exact completed native message', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-opencode-completion-test-'));
  const messageId = 'msg_159b276dc001JG8iGJtPGnCR63';
  const answer = '研究起点标题：输入数量与材料质量。\n摘要代码：青榆R86392。摘要没有原文页码。';
  const info = { id: sid, location: { directory: cwd }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] };
  let started;
  const fake = fakeProcesses([
    openCodeConfig({}), { output: JSON.stringify({ data: info }) }, { output: '{"data":{}}' },
    { output: () => {
      started = Date.now();
      return jsonl(
        { type: 'step_start', sessionID: sid, part: { messageID: messageId } },
        { type: 'text', sessionID: sid, part: { id: 'answer', messageID: messageId, text: answer } },
      );
    } },
    { output: () => JSON.stringify({ data: { ...info, outcome: 'succeeded', time: { idle: Date.now() } } }) },
    { output: () => JSON.stringify({ data: { id: messageId, type: 'assistant', finish: 'stop', rawFinish: 'stop',
      time: { created: started, completed: started }, content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: answer }] } }) },
  ]);
  const events = [];
  try {
    const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ prompt: 'question', cwd, materialCwd: '/snapshot', nativeSessionId: sid, onEvent: event => events.push(event) });
    assert.equal(result.body, answer);
    assert.deepEqual(fake.calls.at(-1).args, ['api', 'GET', `/api/session/${sid}/message/${messageId}`]);
    assert.equal(fake.calls.filter(call => call.args[0] === 'run').length, 1, 'completion lookup never reruns the model');
    assert.deepEqual(events.filter(event => event.type === 'delta'), [{ type: 'delta', text: answer }]);
    assert.equal(JSON.stringify(events).includes('private reasoning'), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('OpenCode completion reconciliation rejects stale, mismatched, partial and unsuccessful native records', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'read-paper-opencode-incomplete-test-'));
  const messageId = 'msg_current123';
  const info = { id: sid, location: { directory: cwd }, permissions: [{ action: '*', resource: '*', effect: 'deny' }] };
  try {
    for (const scenario of [
      { name: 'another message', patch: data => ({ ...data, id: 'msg_older123' }) },
      { name: 'previous turn', patch: data => ({ ...data, time: { created: 1, completed: 2 } }) },
      { name: 'no completion time', patch: data => ({ ...data, time: { created: data.time.created } }) },
      { name: 'length limit', patch: data => ({ ...data, finish: 'length' }) },
      { name: 'unknown finish', patch: data => ({ ...data, finish: 'unknown' }) },
      { name: 'truncated text', patch: data => ({ ...data, content: [{ type: 'text', text: 'answer plus missing suffix' }] }) },
      { name: 'unstreamed tool', patch: data => ({ ...data, content: [...data.content, { type: 'tool', state: { status: 'completed' } }] }) },
      { name: 'interrupted session', outcome: 'interrupted', expectedCalls: 5 },
      { name: 'unbound output', noMessageId: true, expectedCalls: 4 },
      { name: 'explicit incomplete finish', finish: 'length', expectedCalls: 4 },
      { name: 'unreadable completion', malformed: true },
    ]) {
      let started;
      const fake = fakeProcesses([
        openCodeConfig({}), { output: JSON.stringify({ data: info }) }, { output: '{"data":{}}' },
        { output: () => {
          started = Date.now();
          return jsonl(
            { type: 'text', sessionID: sid, part: { id: 'answer', ...(scenario.noMessageId ? {} : { messageID: messageId }), text: 'answer' } },
            ...(scenario.finish ? [{ type: 'step_finish', sessionID: sid, part: { messageID: messageId, reason: scenario.finish } }] : []),
          );
        } },
        { output: () => JSON.stringify({ data: { ...info, outcome: scenario.outcome || 'succeeded', time: { idle: Date.now() } } }) },
        { output: () => {
          if (scenario.malformed) return 'private-native-diagnostic-secret';
          const data = { id: messageId, type: 'assistant', finish: 'stop', time: { created: started, completed: started }, content: [{ type: 'text', text: 'answer' }] };
          return JSON.stringify({ data: scenario.patch ? scenario.patch(data) : data });
        } },
      ]);
      await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: {} }).run({ prompt: 'question', cwd, materialCwd: '/snapshot', nativeSessionId: sid }),
        error => error.code === 'stream_interrupted' && !error.message.includes('private-native-diagnostic-secret'), scenario.name);
      assert.equal(fake.calls.length, scenario.expectedCalls || 6, scenario.name);
      assert.equal(fake.calls.filter(call => call.args[0] === 'run').length, 1, scenario.name);
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('OpenCode resumed sessions keep their frozen native model after global selection changes', async () => {
  const fake = fakeProcesses([openCodeConfig({ model: 'new/default' }), openCodeAnswer()]);
  const result = await createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, env: { OPENCODE_MODEL: 'override/new' } }).run({ prompt: 'follow up', nativeSessionId: sid, nativeModel: 'original/org/model#high' });
  const call = fake.calls[1];
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'original/org/model#high');
  assert.equal(call.args[call.args.indexOf('--session') + 1], sid);
  assert.equal(result.model, 'original/org/model#high');
  assert.equal(fake.calls.length, 2, 'resuming does not consult the changed recent-model state');
});

test('OpenCode rejects actual tool execution and redacts upstream failures', async () => {
  for (const [event, code] of [
    [{ type: 'tool_use', sessionID: sid, part: { state: { status: 'completed' } } }, 'permission_error'],
    [{ type: 'error', sessionID: sid, error: { type: 'provider.auth', message: 'secret-token-123' } }, 'needs-auth'],
    [{ type: 'error', sessionID: sid, error: { type: 'provider.rate-limit', status: 429, message: 'secret-token-123' } }, 'rate_limited'],
  ]) {
    const fake = fakeProcesses([openCodeConfig({}), { output: jsonl(event) }]);
    await assert.rejects(createOpenCodeRuntime({ spawnImpl: fake.spawnImpl, model }).run({ prompt: 'hi' }), (error) => error.code === code && !error.message.includes('secret-token-123'));
    assert.equal(existsSync(fake.calls[1].options.env.OPENCODE_CONFIG_DIR), false);
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
  const opencode = fakeProcesses([openCodeConfig({}), { output: jsonl({ type: 'step_start', sessionID: 'ses_otherSession' }) }]);
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
