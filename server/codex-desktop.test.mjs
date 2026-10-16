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
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: local\ndescription: Local guidance\n---\nRead the selected research materials.');
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
        case 'collaborationMode/list': result = { data: options.modes || [{ name: 'Plan', mode: 'plan' }, { name: 'Default', mode: 'default' }] }; break;
        case 'thread/start': case 'thread/resume': result = { thread: { id: message.params.threadId || 'thread1' }, model: 'native-model' }; break;
        case 'turn/start':
          result = { turn: { id: 'turn1' } };
          setImmediate(() => Promise.resolve(options.onTurn ? options.onTurn({ send, notify, request, finish, child }) : finish()).catch((error) => { child.emit('error', error); }));
          break;
        case 'turn/interrupt': result = {}; break;
      }
      if (message.id !== undefined) send({ id: message.id, result: result || {} });
      callback();
    } });
    captured.push({ executable, args, options: spawnOptions }); children.push(child); return child;
  };
  const runtime = createCodexRuntime({ spawnImpl, rpcTimeoutMs: 500, env: { PRIVATE_TOKEN: 'secret-for-redaction' } });
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
  assert.deepEqual(first.models, [{ id: 'picker-model', name: 'Native model', isDefault: true }]);
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
