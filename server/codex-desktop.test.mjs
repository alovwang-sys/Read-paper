import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRuntime } from './codex-runtime.mjs';

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'read-paper-desktop-test-')));
  const cwd = join(root, 'materials');
  const skillDir = join(root, 'skills', 'local');
  await mkdir(cwd); await mkdir(skillDir, { recursive: true });
  await writeFile(join(cwd, 'manifest.json'), '{}');
  await writeFile(join(skillDir, 'SKILL.md'), options.skillText || '---\nname: local\ndescription: Local guidance\n---\nRead the selected research materials.');
  await mkdir(join(skillDir, 'plugin'));
  await writeFile(join(skillDir, 'plugin', 'SKILL.md'), '---\nname: plugin\ndescription: Plain local guidance\n---\nRead the selected research materials.');
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillPath = join(skillDir, 'SKILL.md');
  const captured = []; const children = []; const nativeReplies = [];
  let enabled = true; let requestId = 1000;
  const spawnImpl = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
    const waiting = new Map();
    const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
    const notify = (method, params) => send({ method, params: { threadId: 'thread1', turnId: 'turn1', ...params } });
    const request = (method, params = {}) => new Promise((resolve) => {
      const id = ++requestId; waiting.set(id, resolve);
      send({ id, method, params: { threadId: 'thread1', turnId: 'turn1', itemId: 'item1', startedAtMs: 1, ...params } });
    });
    const finish = () => {
      notify('item/agentMessage/delta', { delta: 'Original model answer' });
      notify('turn/completed', { turn: { id: 'turn1', status: 'completed' } });
    };
    child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); options.onKill?.({ send, notify, request }); return true; };
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString()); captured.push(message);
      if (!message.method) {
        nativeReplies.push(message); waiting.get(message.id)?.(message.result); waiting.delete(message.id); callback(); return;
      }
      let result;
      switch (message.method) {
        case 'initialize': result = { userAgent: 'codex/0.162.1' }; break;
        case 'config/read': result = { config: { mcp_servers: { external: {} }, plugins: { installed: {} } } }; break;
        case 'command/exec': result = { exitCode: message.params.command[0].includes('touch') || message.params.command[1].endsWith('outside.txt') ? 1 : 0, stdout: '', stderr: '' }; break;
        case 'skills/list': result = { data: [{ skills: options.skills?.({ skillPath, enabled }) || [
          { name: 'local', description: 'Local guidance', path: skillPath, enabled, scope: 'user' },
          { name: 'disabled', description: 'Disabled guidance', path: `${skillDir}/disabled/SKILL.md`, enabled: false, scope: 'user' },
          { name: 'plugin', description: 'Plugin guidance', path: `${skillDir}/plugin/SKILL.md`, enabled: true, scope: 'user', pluginId: 'installed' },
          { name: 'mcp', description: 'Requires a connector', path: `${skillDir}/mcp/SKILL.md`, enabled: true, dependencies: { tools: [{ type: 'mcp', value: 'external' }] } },
        ] }] }; break;
        case 'model/list': result = { data: options.models || [{ id: 'picker-model', model: 'native-model', displayName: 'Native model', isDefault: true, hidden: false, defaultReasoningEffort: 'medium' }], nextCursor: null }; break;
        case 'permissionProfile/list':
          if (options.profilesUnsupported) { send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); callback(); return; }
          result = { data: options.permissionProfiles || [{ id: 'read_paper_materials', allowed: true }, { id: ':danger-full-access', allowed: true }] }; break;
        case 'collaborationMode/list': result = { data: options.modes || [{ name: 'Plan', mode: 'plan' }, { name: 'Default', mode: 'default' }] }; break;
        case 'thread/start': case 'thread/resume': result = { thread: { id: message.params.threadId || 'thread1' }, model: 'native-model' }; break;
        case 'turn/start':
          result = { turn: { id: 'turn1' } };
          setImmediate(() => Promise.resolve(options.onTurn ? options.onTurn({ send, notify, request, finish, child }) : finish()).catch((error) => { child.emit('error', error); }));
          break;
        case 'turn/interrupt': result = {}; if (options.confirmInterrupt !== false) setImmediate(() => notify('turn/completed', { turn: { id: 'turn1', status: 'interrupted' } })); options.onInterrupt?.({ send, notify, child }); break;
      }
      if (message.id !== undefined) send({ id: message.id, result: result || {} });
      callback();
    } });
    captured.push({ executable, args, options: spawnOptions }); children.push(child); return child;
  };
  const runtime = createCodexRuntime({ spawnImpl, tikhubSpawnImpl: options.tikhubSpawnImpl, rpcTimeoutMs: 500, idleTimeoutMs: options.idleTimeoutMs ?? 60_000, interruptTimeoutMs: options.interruptTimeoutMs ?? 100, env: { PRIVATE_TOKEN: 'secret-for-redaction', ...options.env } });
  t.after(() => runtime.close());
  return { runtime, captured, children, nativeReplies, cwd, skillPath, skillDir, setEnabled(value) { enabled = value; } };
}

test('capabilities discover native skills/models/plan without exposing skill paths or enabling disconnected tools', async (t) => {
  const f = await fixture(t);
  const first = await f.runtime.capabilities(); const second = await f.runtime.capabilities();
  assert.deepEqual(first, second);
  assert.match(first.skills[0].id, /^skill_[\w-]{43}$/);
  assert.equal(first.skills[0].enabled, true);
  assert.ok(first.skills.filter((skill) => ['disabled', 'mcp'].includes(skill.name)).every((skill) => !skill.enabled && skill.disabledReason));
  assert.equal(first.skills.find((skill) => skill.name === 'plugin').enabled, true);
  assert.match(first.skills.find((skill) => skill.name === 'plugin').description, /插件及外部工具仍未接入/);
  assert.deepEqual(first.models, [{ id: 'picker-model', name: 'Native model', isDefault: true, defaultReasoningEffort: 'medium' }]);
  assert.deepEqual(first.accessModes, ['read-only', 'full-access']);
  assert.equal(first.plan, true);
  assert.doesNotMatch(JSON.stringify(first), /SKILL\.md|nativeModel|sourcePath|\/skills\//);
  assert.ok(f.children.every((child) => child.killed));
  assert.ok(!f.captured.some((entry) => entry.method === 'turn/start'));
});

test('native skill input, selected readonly roots, catalog model mapping and real Plan collaboration mode', async (t) => {
  const f = await fixture(t); const catalog = await f.runtime.capabilities();
  const result = await f.runtime.run({ cwd: f.cwd, prompt: 'Plan with the selected skill', skillIds: [catalog.skills[0].id], codex: { model: 'picker-model', mode: 'plan' } });
  assert.equal(result.body, 'Original model answer');
  const start = f.captured.find((entry) => entry.method === 'thread/start').params;
  const turn = f.captured.find((entry) => entry.method === 'turn/start').params;
  assert.equal(start.approvalPolicy, 'on-request'); assert.equal(start.approvalsReviewer, 'user');
  assert.equal(start.allowProviderModelFallback, false); assert.equal(start.permissions, 'read_paper_materials');
  assert.equal(start.model, 'native-model');
  assert.deepEqual(start.runtimeWorkspaceRoots, [f.cwd, f.skillDir]);
  assert.equal(start.config['mcp_servers.external.enabled'], false); assert.equal(start.config['plugins.installed.enabled'], false);
  assert.deepEqual(start.config['skills.config'][0], { path: f.skillPath, enabled: true });
  assert.ok(start.config['skills.config'].slice(1).every((skill) => skill.enabled === false));
  assert.deepEqual(turn.input[1], { type: 'skill', name: 'local', path: f.skillPath });
  assert.deepEqual(f.captured.find((entry) => entry.method === 'skills/extraRoots/set').params, { extraRoots: [f.skillDir] });
  assert.deepEqual(turn.collaborationMode, { mode: 'plan', settings: { model: 'native-model', developer_instructions: null, reasoning_effort: 'medium' } });
  assert.ok(f.captured.filter((entry) => entry.executable).every((entry) => entry.options.shell === false));
});

test('Codex sends immutable local images only when the selected model explicitly advertises image input', async t => {
  const models = [
    { id: 'vision', model: 'native-vision', displayName: 'Vision', isDefault: true, inputModalities: ['text', 'image'] },
    { id: 'text', model: 'native-text', displayName: 'Text', inputModalities: ['text'] },
    { id: 'unknown', model: 'native-unknown', displayName: 'Legacy catalog' },
  ];
  const f = await fixture(t, { models });
  const image = join(f.cwd, 'region-1.png');
  await writeFile(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { mode: 0o400 });
  const catalog = await f.runtime.capabilities();
  assert.deepEqual(catalog.models[0].inputModalities, ['text', 'image']);
  assert.equal(catalog.models[2].inputModalities, undefined);
  assert.equal((await f.runtime.probe()).capabilities.images, true);
  const imagePaths = [{ evidenceId: 'region-evidence', path: image }];
  for (const model of ['text', 'unknown']) await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Explain this figure', codex: { model }, imagePaths }), { code: 'images_unsupported' });
  assert.ok(!f.captured.some(entry => entry.method === 'thread/start' || entry.method === 'turn/start'));
  await f.runtime.run({ cwd: f.cwd, prompt: 'Explain this figure', codex: { model: 'vision' }, imagePaths });
  const turn = f.captured.find(entry => entry.method === 'turn/start').params;
  assert.equal(turn.model, 'native-vision');
  assert.deepEqual(turn.input.slice(1), [
    { type: 'text', text: '区域图片来源 evidenceId=region-evidence', text_elements: [] },
    { type: 'localImage', path: image },
  ]);
  assert.doesNotMatch(JSON.stringify(turn), /data:image/);
  const unknown = await fixture(t);
  assert.equal((await unknown.runtime.probe()).capabilities.images, false);
});

test('Codex refuses image paths outside the material directory before spawning', async t => {
  const f = await fixture(t);
  const outside = join(f.skillDir, 'region-1.png');
  await writeFile(outside, 'outside');
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, imagePaths: [{ evidenceId: 'e1', path: outside }] }), { code: 'invalid_input' });
  assert.equal(f.children.length, 0);
});

test('invalid and newly disabled skills, unknown models and unavailable Plan never start a model turn', async (t) => {
  const f = await fixture(t); const catalog = await f.runtime.capabilities();
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', skillIds: [f.skillPath], codex: {} }), { code: 'invalid_skill' });
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', skillIds: [`skill_${'a'.repeat(43)}`], codex: {} }), { code: 'invalid_skill' });
  f.setEnabled(false);
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', skillIds: [catalog.skills[0].id], codex: {} }), { code: 'invalid_skill' });
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: { model: 'not-in-native-catalog' } }), { code: 'invalid_model' });
  assert.ok(!f.captured.some((entry) => entry.method === 'turn/start'));
  const noPlan = await fixture(t, { modes: [] });
  await assert.rejects(noPlan.runtime.run({ cwd: noPlan.cwd, prompt: 'Q', codex: { mode: 'plan' } }), { code: 'capability_unavailable' });
  assert.ok(!noPlan.captured.some((entry) => entry.method === 'turn/start'));
});

test('one-time command/file/permission approvals map to native responses while unknown and persistent permissions are denied', async (t) => {
  const actual = []; const interactions = [];
  const f = await fixture(t, { onTurn: async ({ notify, request, finish }) => {
    actual.push(await request('item/commandExecution/requestApproval', { command: 'cat materials.md', cwd: '/materials', availableDecisions: ['accept', 'acceptForSession', 'decline'], reason: 'Read selected material' }));
    notify('item/started', { item: { id: 'file1', type: 'fileChange', changes: [{ path: '/materials/draft.md', diff: '-old\n+new', kind: { type: 'update' } }] } });
    actual.push(await request('item/fileChange/requestApproval', { itemId: 'file1', reason: 'Update the draft' }));
    actual.push(await request('item/permissions/requestApproval', { cwd: '/materials', permissions: { fileSystem: { read: ['/chosen/file'] }, network: { enabled: true } } }));
    actual.push(await request('item/permissions/requestApproval', { cwd: '/materials', permissions: { unknown: true } }));
    actual.push(await request('item/fileChange/requestApproval', { grantRoot: '/materials', itemId: 'file1' }));
    actual.push(await request('item/commandExecution/requestApproval', { command: 'cat secrets', kind: 'stdin' }));
    finish();
  } });
  const result = await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: { mode: 'chat' }, onInteraction: async (input) => { interactions.push(input); return { decision: 'allowOnce' }; } });
  assert.deepEqual(actual, [{ decision: 'accept' }, { decision: 'accept' }, { permissions: { fileSystem: { read: ['/chosen/file'] }, network: { enabled: true } }, scope: 'turn' }, { permissions: {}, scope: 'turn' }, { decision: 'decline' }, { decision: 'decline' }]);
  assert.equal(interactions.length, 3); assert.equal(interactions[0].command, 'cat materials.md');
  assert.match(interactions[1].detail, /draft\.md/); assert.match(interactions[1].detail, /-old\n\+new/); assert.match(interactions[2].detail, /仅当前回合/);
  assert.equal(result.body, 'Original model answer');
  assert.doesNotMatch(JSON.stringify(actual), /acceptForSession|execpolicy/);
});

test('deny and structured questions preserve the native question IDs and answer envelope', async (t) => {
  const actual = []; const inputs = [];
  const f = await fixture(t, { onTurn: async ({ request, finish }) => {
    actual.push(await request('item/commandExecution/requestApproval', { command: 'cat materials.md' }));
    actual.push(await request('item/tool/requestUserInput', { isBlocking: true, questions: [
      { id: 'direction', header: '方向', question: 'Choose a direction', options: [{ label: 'Compare', description: 'Compare the evidence' }] },
      { id: 'detail', header: '补充', question: 'Any details?', options: null },
    ] })); finish();
  } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, onInteraction: async (input) => { inputs.push(input); return input.kind === 'approval' ? { decision: 'deny' } : { answers: { direction: ['Compare'], detail: ['Focus on methods'] } }; } });
  assert.deepEqual(actual, [{ decision: 'decline' }, { answers: { direction: { answers: ['Compare'] }, detail: { answers: ['Focus on methods'] } } }]);
  assert.equal(inputs[1].kind, 'question'); assert.equal(inputs[1].questions[0].id, 'direction'); assert.equal(inputs[1].questions[0].allowOther, false); assert.deepEqual(inputs[1].questions[1].options, []); assert.equal(inputs[1].questions[1].allowOther, true);
});

test('approval never accepts truncated commands, redacted secrets, hidden file diffs or unknown permission paths', async (t) => {
  const replies = []; let interactions = 0;
  const f = await fixture(t, { onTurn: async ({ request, notify, finish }) => {
    replies.push(await request('item/commandExecution/requestApproval', { command: 'x'.repeat(4001) }));
    replies.push(await request('item/commandExecution/requestApproval', { command: 'echo secret-for-redaction' }));
    replies.push(await request('item/permissions/requestApproval', { cwd: '/materials', permissions: { fileSystem: { read: ['/secret-for-redaction'] } } }));
    replies.push(await request('item/permissions/requestApproval', { cwd: '/materials', permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'glob_pattern', pattern: '/**' } }] } } }));
    for (const [id, diff] of [['missing', undefined], ['secret', 'secret-for-redaction'], ['large', 'x'.repeat(8001)]]) {
      notify('item/started', { item: { id, type: 'fileChange', changes: [{ path: '/materials/draft.md', diff, kind: { type: 'update' } }] } });
      replies.push(await request('item/fileChange/requestApproval', { itemId: id }));
    }
    finish();
  } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, onInteraction: () => { interactions++; return { decision: 'allowOnce' }; } });
  assert.equal(interactions, 0);
  assert.deepEqual(replies, [{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }, { permissions: {}, scope: 'turn' }, { decision: 'decline' }, { decision: 'decline' }, { decision: 'decline' }]);
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Q', skillIds: Array(5).fill(`skill_${'a'.repeat(43)}`), codex: {} }), { code: 'invalid_skill' });
});

test('questions advertise native freeform permission and reject secret questions without opening the broker', async (t) => {
  const inputs = []; const actual = [];
  const f = await fixture(t, { onTurn: async ({ request, finish }) => {
    actual.push(await request('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'scope', header: '范围', question: 'Which scope?', isOther: true, options: [{ label: 'Methods', description: 'Use methods' }] }] })); finish();
  } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, onInteraction: (input) => { inputs.push(input); return { answers: { scope: ['Custom scope'] } }; } });
  assert.equal(inputs[0].questions[0].allowOther, true);
  assert.deepEqual(actual, [{ answers: { scope: { answers: ['Custom scope'] } } }]);
  const secret = await fixture(t, { onTurn: ({ request }) => request('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'password', header: '凭据', question: 'Enter password', isSecret: true }] }) });
  let opened = false;
  await assert.rejects(secret.runtime.run({ cwd: secret.cwd, prompt: 'Q', codex: {}, onInteraction: () => { opened = true; } }), { code: 'input_required' });
  assert.equal(opened, false);
});

test('cancel during a pending interaction closes only the owned process and ignores late replies and other-thread events', async (t) => {
  const controller = new AbortController(); const inputs = []; const events = [];
  let answer;
  const f = await fixture(t, { onTurn: async ({ notify, request }) => {
    notify('item/agentMessage/delta', { threadId: 'other-thread', delta: 'WRONG THREAD' });
    await request('item/commandExecution/requestApproval', { threadId: 'other-thread', command: 'WRONG COMMAND' });
    await request('item/commandExecution/requestApproval', { command: 'cat materials.md' });
  }, onKill: ({ notify }) => notify('item/agentMessage/delta', { delta: 'LATE ANSWER' }) });
  const running = f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, signal: controller.signal, onEvent: (event) => events.push(event), onInteraction: (input) => { inputs.push(input); controller.abort(); return new Promise((resolve) => { answer = resolve; }); } });
  await assert.rejects(running, { code: 'stopped' });
  answer({ decision: 'allowOnce' }); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inputs.length, 1); assert.equal(inputs[0].command, 'cat materials.md');
  assert.doesNotMatch(JSON.stringify(events), /WRONG|LATE/);
  assert.ok(f.children.every((child) => child.killed));
  assert.ok(!f.nativeReplies.some((reply) => reply.result?.decision === 'accept'));
});

test('chat resets native collaboration mode and resume replaces the previous selected skill roots', async (t) => {
  const f = await fixture(t); const caps = await f.runtime.capabilities();
  await f.runtime.run({ cwd: f.cwd, prompt: 'Plan', skillIds: [caps.skills[0].id], codex: { mode: 'plan' } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Chat', nativeSessionId: 'thread1', skillIds: [], codex: { mode: 'chat' } });
  const resume = f.captured.find((entry) => entry.method === 'thread/resume').params;
  const turn = f.captured.filter((entry) => entry.method === 'turn/start').at(-1).params;
  assert.deepEqual(resume.runtimeWorkspaceRoots, [f.cwd]);
  assert.ok(resume.config['skills.config'].every((skill) => !skill.enabled));
  assert.equal(turn.collaborationMode.mode, 'default'); assert.equal(turn.input.length, 1);
  assert.deepEqual(f.captured.filter((entry) => entry.method === 'skills/extraRoots/set').at(-1).params, { extraRoots: [] });
});

test('plain plugin skills load only through explicit native extra roots while the distributing plugin remains disabled', async (t) => {
  const f = await fixture(t); const caps = await f.runtime.capabilities();
  const plugin = caps.skills.find((skill) => skill.name === 'plugin');
  await f.runtime.run({ cwd: f.cwd, prompt: 'Use the chosen local guidance', skillIds: [plugin.id], codex: {} });
  const start = f.captured.find((entry) => entry.method === 'thread/start').params;
  const turn = f.captured.find((entry) => entry.method === 'turn/start').params;
  assert.equal(start.config['plugins.installed.enabled'], false);
  assert.deepEqual(turn.input[1], { type: 'skill', name: 'plugin', path: join(f.skillDir, 'plugin', 'SKILL.md') });
  assert.deepEqual(f.captured.find((entry) => entry.method === 'skills/extraRoots/set').params, { extraRoots: [join(f.skillDir, 'plugin')] });
});

test('selected TikHub registers native tools, routes real tool requests once and keeps activity separate from answer text', async t => {
  const pythonCalls = [], replies = [], events = [];
  const f = await fixture(t, {
    env: { TIKHUB_API_KEY: 'fixture-only-credential' },
    skillText: '---\nname: tikhub\ndescription: TikHub MCP\n---\nUse the TikHub MCP tools.',
    skills: ({ skillPath, enabled }) => [{ name: 'tikhub', description: 'TikHub MCP', path: skillPath, enabled }],
    tikhubSpawnImpl: (executable, args, options) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit('close', 0); };
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
        pythonCalls.push({ executable, args, options });
        queueMicrotask(() => { child.stdout.write(JSON.stringify({ platform: 'douyin', toolCount: 319 })); child.exitCode = 0; child.emit('close', 0); }); callback();
      } }); return child;
    },
    onTurn: async ({ notify, request, finish }) => {
      const args = { action: 'check', platform: 'douyin' }, call = { callId: 'tik1', tool: 'read_paper_tikhub', arguments: args };
      notify('item/started', { item: { id: 'tik1', type: 'dynamicToolCall', tool: call.tool, arguments: args, status: 'inProgress' } });
      replies.push(await request('item/tool/call', call));
      replies.push(await request('item/tool/call', call));
      replies.push(await request('item/tool/call', { ...call, arguments: { action: 'platforms' } }));
      replies.push(await request('item/tool/call', { ...call, threadId: 'another', callId: 'foreign' }));
      notify('item/completed', { item: { id: 'tik1', type: 'dynamicToolCall', tool: call.tool, arguments: args, status: 'completed', ...replies[0] } });
      finish();
    },
  });
  await mkdir(join(f.skillDir, 'scripts')); await writeFile(join(f.skillDir, 'scripts', 'tikhub.py'), '# fixture only');
  const caps = await f.runtime.capabilities();
  assert.equal(caps.skills[0].enabled, true); assert.match(caps.skills[0].description, /已接入 TikHub/);
  assert.doesNotMatch(JSON.stringify(caps), /fixture-only-credential|tikhub\.py|scriptPath/);
  const answer = await f.runtime.run({ cwd: f.cwd, prompt: 'Only check tool discovery', skillIds: [caps.skills[0].id], codex: {}, onEvent: event => events.push(event) });
  assert.equal(answer.body, 'Original model answer'); assert.equal(pythonCalls.length, 1);
  assert.equal(replies[0].success, true); assert.deepEqual(replies[0], replies[1]);
  assert.equal(replies[2].success, false); assert.equal(replies[3].success, false);
  const start = f.captured.find(entry => entry.method === 'thread/start').params;
  assert.equal(start.dynamicTools[0].name, 'read_paper_tikhub'); assert.equal(start.config['mcp_servers.external.enabled'], false);
  assert.ok(!start.runtimeWorkspaceRoots.some(path => path.includes('secrets')));
  assert.match(events.find(event => event.type === 'progress' && event.status === 'done').output, /319/);
  assert.doesNotMatch(JSON.stringify(events), /fixture-only-credential/);
});

test('TikHub tool requests are rejected when its Skill was not selected, including during native resume', async t => {
  const replies = [];
  const f = await fixture(t, { onTurn: async ({ request, finish }) => { replies.push(await request('item/tool/call', { callId: 'unselected', tool: 'read_paper_tikhub', arguments: { action: 'platforms' } })); finish(); } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Q', nativeSessionId: 'thread1', skillIds: [], codex: {} });
  assert.equal(replies[0].success, false);
  assert.ok(!f.captured.find(entry => entry.method === 'thread/resume').params.dynamicTools);
});

test('managed threads register a guarded tool once and enable or deny it per turn without changing threads', async t => {
  const replies = [], pythonCalls = [];
  const f = await fixture(t, {
    env: { TIKHUB_API_KEY: 'fixture-only-credential' },
    skillText: '---\nname: tikhub\ndescription: TikHub MCP\n---\nUse the TikHub MCP tools.',
    skills: ({ skillPath, enabled }) => [{ name: 'tikhub', description: 'TikHub MCP', path: skillPath, enabled }],
    tikhubSpawnImpl: (executable, args) => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
      child.kill = () => { child.exitCode = 0; child.emit('close', 0); };
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); }, final(callback) {
        pythonCalls.push({ executable, args }); queueMicrotask(() => { child.stdout.write(JSON.stringify({ platforms: ['douyin'] })); child.exitCode = 0; child.emit('close', 0); }); callback();
      } }); return child;
    },
    onTurn: async ({ request, finish }) => { replies.push(await request('item/tool/call', { callId: 'controlled', tool: 'read_paper_tikhub', arguments: { action: 'platforms' } })); finish(); },
  });
  await mkdir(join(f.skillDir, 'scripts')); await writeFile(join(f.skillDir, 'scripts', 'tikhub.py'), '# fixture only');
  const capabilities = await f.runtime.capabilities();
  const first = await f.runtime.run({ managedKey: 'same-chat', cwd: f.cwd, prompt: 'First, no external tool', skillIds: [], codex: {} });
  const second = await f.runtime.run({ managedKey: 'same-chat', cwd: f.cwd, nativeSessionId: first.nativeSessionId, nativeToolsVersion: first.nativeToolsVersion, prompt: 'Now use my selected TikHub skill', skillIds: [capabilities.skills[0].id], codex: {} });
  const third = await f.runtime.run({ managedKey: 'same-chat', cwd: f.cwd, nativeSessionId: first.nativeSessionId, prompt: 'Do not use TikHub this turn', skillIds: [], codex: {} });
  assert.equal(first.nativeToolsVersion, 1); assert.equal(second.nativeSessionId, first.nativeSessionId); assert.equal(third.nativeSessionId, first.nativeSessionId);
  assert.deepEqual(replies.map(reply => reply.success), [false, true, false]); assert.equal(pythonCalls.length, 1);
  assert.equal(f.captured.filter(entry => entry.method === 'thread/start').length, 1);
  assert.equal(f.captured.find(entry => entry.method === 'thread/start').params.dynamicTools[0].name, 'read_paper_tikhub');
  assert.ok(f.captured.filter(entry => entry.method === 'thread/resume').every(entry => entry.params.dynamicTools === undefined));
  assert.ok(!f.captured.some(entry => entry.method === 'thread/fork'));
});

test('an old thread without a registered toolset requires an explicit new conversation before adding TikHub', async t => {
  const f = await fixture(t, { env: { TIKHUB_API_KEY: 'fixture-only-credential' }, skillText: '---\nname: tikhub\ndescription: TikHub MCP\n---\nUse TikHub MCP tools.', skills: ({ skillPath, enabled }) => [{ name: 'tikhub', description: 'TikHub MCP', path: skillPath, enabled }] });
  await mkdir(join(f.skillDir, 'scripts')); await writeFile(join(f.skillDir, 'scripts', 'tikhub.py'), '# fixture only');
  const capabilities = await f.runtime.capabilities();
  await assert.rejects(f.runtime.run({ managedKey: 'old-chat', cwd: f.cwd, nativeSessionId: 'existing-native', prompt: 'Add TikHub', skillIds: [capabilities.skills[0].id], codex: {} }), { code: 'new_conversation_required' });
  assert.ok(!f.captured.some(entry => ['thread/start', 'thread/resume', 'thread/fork', 'turn/start'].includes(entry.method)));
});

test('native reasoning effort catalog drives actual turn and Plan settings, including Ultra only when advertised', async t => {
  const f = await fixture(t, { models: [{ id: 'picker-model', model: 'native-model', displayName: 'Native model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }, { reasoningEffort: 'ultra', description: 'Deepest supported effort' }] }] });
  const catalog = await f.runtime.capabilities();
  assert.deepEqual(catalog.models[0].reasoningEfforts, [{ effort: 'medium', description: 'Balanced' }, { effort: 'ultra', description: 'Deepest supported effort' }]);
  await f.runtime.run({ cwd: f.cwd, prompt: 'Plan', codex: { model: 'picker-model', effort: 'ultra', mode: 'plan' } });
  const turn = f.captured.find(entry => entry.method === 'turn/start').params;
  assert.equal(turn.effort, 'ultra'); assert.equal(turn.collaborationMode.settings.reasoning_effort, 'ultra');
  const count = f.captured.filter(entry => entry.method === 'turn/start').length;
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Invalid effort', codex: { effort: 'unsupported' } }), { code: 'invalid_effort' });
  assert.equal(f.captured.filter(entry => entry.method === 'turn/start').length, count);
  await assert.rejects(f.runtime.run({ cwd: f.cwd, prompt: 'Invalid effort', codex: { effort: 'ultra\n' } }), { code: 'invalid_effort' });
});

test('full access is explicit and allowed by native policy; resumed next turns explicitly restore readonly defaults', async t => {
  const f = await fixture(t);
  await f.runtime.run({ cwd: f.cwd, prompt: 'Explicit full access', codex: { access: 'full-access', mode: 'chat' } });
  await f.runtime.run({ cwd: f.cwd, nativeSessionId: 'thread1', prompt: 'Return to defaults', codex: { mode: 'chat' } });
  const opened = f.captured.find(entry => entry.method === 'thread/start').params;
  const resumed = f.captured.find(entry => entry.method === 'thread/resume').params;
  const turns = f.captured.filter(entry => entry.method === 'turn/start').map(entry => entry.params);
  assert.equal(opened.permissions, ':danger-full-access'); assert.equal(opened.approvalPolicy, 'never');
  assert.match(opened.developerInstructions, /完全访问/); assert.doesNotMatch(opened.developerInstructions, /默认仅可读取/);
  assert.equal(turns[0].permissions, ':danger-full-access'); assert.equal(turns[0].approvalPolicy, 'never');
  assert.equal(resumed.permissions, 'read_paper_materials'); assert.equal(resumed.approvalPolicy, 'on-request');
  assert.equal(turns[1].permissions, 'read_paper_materials'); assert.equal(turns[1].approvalPolicy, 'on-request');
  assert.equal(opened.config['mcp_servers.external.enabled'], false);
  assert.ok(f.captured.filter(entry => entry.executable).every(entry => !entry.args.some(arg => arg.includes('danger-full-access'))));
});

test('restricted or legacy permission catalogs never expose or fall back to broader access', async t => {
  const restricted = await fixture(t, { permissionProfiles: [{ id: 'read_paper_materials', allowed: true }, { id: ':danger-full-access', allowed: false }, { id: ':workspace', allowed: true }] });
  assert.deepEqual((await restricted.runtime.capabilities()).accessModes, ['read-only']);
  for (const access of ['full-access', 'workspace-write']) await assert.rejects(restricted.runtime.run({ cwd: restricted.cwd, prompt: 'Q', codex: { access } }), { code: 'capability_unavailable' });
  await assert.rejects(restricted.runtime.run({ cwd: restricted.cwd, prompt: 'Q', codex: { access: 'danger-full-access' } }), { code: 'invalid_access' });
  assert.ok(!restricted.captured.some(entry => entry.method === 'thread/start'));
  const legacy = await fixture(t, { profilesUnsupported: true });
  assert.deepEqual((await legacy.runtime.capabilities()).accessModes, ['read-only']);
  await legacy.runtime.run({ cwd: legacy.cwd, prompt: 'Readonly legacy', codex: {} });
  await assert.rejects(legacy.runtime.run({ cwd: legacy.cwd, prompt: 'No broad fallback', codex: { access: 'full-access' } }), { code: 'capability_unavailable' });
  assert.ok(legacy.captured.filter(entry => entry.method === 'thread/start').every(entry => entry.params.permissions === 'read_paper_materials'));
});

test('native turn diff updates are bounded and sanitized separately from answers, ignoring foreign and late events', async t => {
  const events = [];
  const patch = 'diff --git a/note.md b/note.md\n--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-old\n+secret-for-redaction\n';
  const f = await fixture(t, { onTurn({ notify, finish }) {
    notify('turn/diff/updated', { diff: '' });
    notify('turn/diff/updated', { threadId: 'foreign-thread', diff: patch });
    notify('turn/diff/updated', { turnId: 'foreign-turn', diff: patch });
    notify('turn/diff/updated', { diff: patch });
    notify('turn/diff/updated', { diff: patch + 'x'.repeat(20_000) });
    finish(); notify('turn/diff/updated', { diff: patch.replace('note.md', 'late.md') });
  } });
  const result = await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, onEvent: event => events.push(event) });
  const diffs = events.filter(event => event.id === 'turn-diff');
  assert.equal(diffs.length, 2); assert.ok(diffs.every(event => event.toolName === 'fileChange' && event.status === 'done' && event.command === '本轮原生文件变更' && event.output.length <= 12_000));
  assert.match(diffs[1].text, /仅显示部分/);
  assert.match(diffs[0].output, /已隐藏凭据/); assert.doesNotMatch(JSON.stringify(diffs), /secret-for-redaction|late\.md/);
  assert.equal(result.body, 'Original model answer');
});

test('native credential file patches are hidden while ordinary fileChange retains actual patch output', async t => {
  const events = [];
  const f = await fixture(t, { onTurn({ notify, finish }) {
    notify('turn/diff/updated', { diff: 'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n+UNUSUAL_SETTING=private-content\n' });
    notify('item/completed', { item: { id: 'file-patch', type: 'fileChange', status: 'completed', changes: [{ path: '/materials/note.md', kind: { type: 'update' }, diff: '-old\n+new' }] } });
    finish();
  } });
  await f.runtime.run({ cwd: f.cwd, prompt: 'Q', codex: {}, onEvent: event => events.push(event) });
  assert.equal(events.find(event => event.id === 'turn-diff').output, '[已隐藏配置或凭据文件输出]');
  assert.match(events.find(event => event.id === 'file-patch').output, /-old\n\+new/);
  assert.doesNotMatch(JSON.stringify(events), /private-content/);
});
