import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkClaudeHelp, checkClaudeInit, checkCodexSchema } from './agent-selfcheck.mjs';
import { writeCodexSchema } from './codex-schema.fixture.mjs';

async function schemaDir(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'read-paper-schema-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  if (options) await writeCodexSchema(dir, options);
  return dir;
}

test('Codex protocol self-check passes the shape this adapter uses and names what a removed field costs', async t => {
  assert.deepEqual(await checkCodexSchema(await schemaDir(t, {})), { checked: 25, warnings: [] });
  const changed = await checkCodexSchema(await schemaDir(t, { drop: ['effort', 'live', 'item/plan/delta', 'plan', 'item/tool/call'] }));
  assert.equal(changed.checked, 25);
  assert.deepEqual(changed.warnings, [
    '协议缺少 item/plan/delta、plan：规划内容可能不显示；需要更新本应用的适配。',
    '协议缺少 item/tool/call：逐页阅读与引用草稿工具无法调用；需要更新本应用的适配。',
    '协议缺少 effort：所选思考程度不会生效；需要更新本应用的适配。',
    '协议缺少 live：「自动」模式可能不会联网；需要更新本应用的适配。',
  ]);
});

test('Codex protocol self-check says it was skipped rather than passing when the schema is missing or unreadable', async t => {
  assert.match((await checkCodexSchema(await schemaDir(t))).skipped, /格式已变/);
  const broken = await schemaDir(t);
  await writeFile(join(broken, 'ClientRequest.json'), '{not json');
  assert.match((await checkCodexSchema(broken)).skipped, /无法解析/);
});

test('Claude help and init checks read only what the CLI reports about itself', () => {
  const help = '-p, --print --output-format --verbose --include-partial-messages --safe-mode --disable-slash-commands --tools --allowedTools --strict-mcp-config --mcp-config --effort --model\n  --permission-mode <mode>   Permission mode\n      (choices: "acceptEdits", "dontAsk",\n      "plan")';
  assert.deepEqual(checkClaudeHelp(help), { missing: [], warnings: [], checked: 15, flags: { permissionPrompts: false, effort: true, model: true, web: true, plan: true } });
  // Without a choices list the modes cannot be confirmed either way, so nothing is claimed about them.
  assert.equal(checkClaudeHelp(help.replace(/\(choices[\s\S]*\)/, '')).checked, 14);
  assert.deepEqual(checkClaudeInit({ tools: [], mcp_servers: [] }), { extra: [], warnings: [] });
  assert.deepEqual(checkClaudeInit({ tools: ['WebSearch', 'WebFetch'] }, { web: true }), { extra: [], warnings: [] });
  assert.deepEqual(checkClaudeInit({ tools: ['WebSearch'] }).extra, ['WebSearch'], 'web tools are extra when the run did not ask for them');
  assert.match(checkClaudeInit({}).warnings[0], /不再报告工具列表/);
});
