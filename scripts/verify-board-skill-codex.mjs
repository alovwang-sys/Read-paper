import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compileAgentPrompt } from '../server/agents.mjs';
import { createCodexRuntime } from '../server/codex-runtime.mjs';

// --run permits at most two real requests; --self-check validates only synthetic data and the production parser.
const mode = process.argv[2];
const single = process.argv.includes('--single');
if (!['--run', '--self-check'].includes(mode)) {
  console.log('Usage: node scripts/verify-board-skill-codex.mjs --self-check | --run [--single]');
  process.exit(0);
}
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-board-codex-')));
let parseBoardPlan, previewBoardPlan, validateBoardSnapshot;
const sentinel = 'Only synthetic materials. This original file must remain unchanged.\n';
const digest = value => createHash('sha256').update(value).digest('hex');
const redact = value => String(value).replaceAll(directory, '<temporary-research-directory>').replaceAll(homedir(), '<user-home>');
const resources = [
  { ref: { kind: 'card', id: 'card-input' }, title: '输入数据', body: '合成实验的输入是一组字符串。', evidenceIds: [] },
  { ref: { kind: 'card', id: 'card-method' }, title: '编码模块', body: '编码模块读取输入字符串并转换为数字。', evidenceIds: [] },
  { ref: { kind: 'card', id: 'card-output' }, title: '输出结果', body: '输出结果是编码模块得到的数字序列。', evidenceIds: [] },
];
let context = {
  researchId: 'research-probe', boardId: 'board-probe', revision: 0,
  snapshot: { board: { id: 'board-probe', researchId: 'research-probe', title: '合成方法架构' }, placements: resources.map((resource, i) => ({ id: `placement-${i}`, boardId: 'board-probe', resourceRef: resource.ref, x: 40, y: i * 300, group: '未整理' })), edges: [] }, resources,
};
const report = {
  version: 1, executedAt: new Date().toISOString(), status: 'not-run',
  runtime: 'production compileAgentPrompt + createCodexRuntime; production parseBoardPlan + previewBoardPlan loaded with installed TypeScript compiler',
  fixture: { data: 'synthetic-only', directory: '<temporary-research-directory>', originalFiles: ['original.txt'] },
  request: { attemptedModelCalls: 0, maxModelCalls: single ? 1 : 2, generationDeadline: null, access: 'read-only', nativeSkillIds: [], builtInSkill: 'papertrail-board', externalDesktopUI: 'not-checked', ...(single ? { diagnostic: 'single-turn, explicit low effort, no user configuration changes', effort: 'low' } : {}) },
  checks: { parserSelfCheck: false, firstPlanAccepted: false, followUpAccepted: single ? null : false, nativeSessionReturned: false, sameNativeSessionResumed: single ? null : false, originalFilesUnchanged: false },
  turns: [], tools: [],
};
const history = [];
const runtime = createCodexRuntime({ rpcTimeoutMs: 10_000 });
const controller = new AbortController();
let sessionId;
const started = Date.now();
function accepted(raw, boardContext) {
  const plan = parseBoardPlan(raw, boardContext), preview = previewBoardPlan(boardContext, plan);
  validateBoardSnapshot(preview, boardContext.boardId, boardContext.researchId);
  assert.equal(plan.nodes.length, 3); assert.equal(new Set(plan.nodes.map(node => node.resourceRef.id)).size, 3);
  return { plan, preview };
}
try {
  for (const name of ['citations', 'board-structure', 'board-layout', 'board-history']) {
    const source = await readFile(join(repository, `src/domain/${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'");
    await writeFile(join(directory, `${name}.mjs`), compiled);
  }
  ({ parseBoardPlan, previewBoardPlan, validateBoardSnapshot } = await import(pathToFileURL(join(directory, 'board-history.mjs'))));
  await writeFile(join(directory, 'original.txt'), sentinel);
  const selfPlan = { summary: '合成自检', title: context.snapshot.board.title, layout: 'flow', nodes: context.snapshot.placements.map(p => ({ placementId: p.id, resourceRef: p.resourceRef, group: '方法' })), edges: [{ from: 0, to: 1, label: '输入' }, { from: 1, to: 2, label: '输出' }] };
  const selfCheck = accepted(JSON.stringify(selfPlan), context);
  assert.equal(selfCheck.preview.edges.length, 2);
  report.checks.parserSelfCheck = true;
  if (mode === '--run') {
    const prompts = ['将这三个已有对象组织成输入→编码→输出的方法架构。保留全部已有摆放，使用 flow 布局，建立输入到编码、编码到输出的两条连线。只返回本轮 Skill 规定的 JSON。', '保留当前三个对象和两条连线，只将编码模块的分组改为“核心处理”，使用 preserve 布局，保留白板标题和已有摆放 ID。只返回本轮 Skill 规定的 JSON。'];
    for (let i = 0; i < report.request.maxModelCalls; i++) {
      const requestId = `board-probe-${i + 1}`;
      const request = { requestId, purpose: 'chat', prompt: prompts[i], context: [], history, boardContext: context };
      const turn = { requestId, usedExistingSession: !!sessionId, prompt: prompts[i] };
      report.turns.push(turn); report.request.attemptedModelCalls++;
      const result = await runtime.run({
        cwd: directory, materialCwd: directory, nativeSessionId: sessionId, signal: controller.signal,
        title: 'Papertrail synthetic board skill verification', skillIds: [], codex: { mode: 'chat', access: 'read-only', ...(single ? { effort: 'low' } : {}) },
        prompt: compileAgentPrompt(request),
        onEvent(event) {
          if (event.type === 'session' && event.nativeSessionId) { turn.nativeSessionId = event.nativeSessionId; turn.nativeTurnId = event.nativeTurnId ?? turn.nativeTurnId; report.checks.nativeSessionReturned = true; }
          if (event.type === 'progress' && event.kind === 'tool' && report.tools.length < 16) report.tools.push({ toolName: event.toolName, status: event.status });
        },
      });
      turn.nativeSessionId = result.nativeSessionId; turn.nativeTurnId = result.nativeTurnId;
      turn.model = result.model; turn.rawBody = redact(result.body);
      const parsed = accepted(result.body, context);
      assert.equal(parsed.plan.edges.length, 2);
      if (i === 1) assert.equal(parsed.plan.nodes.find(node => node.resourceRef.id === 'card-method').group, '核心处理');
      turn.plan = parsed.plan; turn.preview = parsed.preview; turn.accepted = true;
      if (i === 0) report.checks.firstPlanAccepted = true;
      else { report.checks.followUpAccepted = true; report.checks.sameNativeSessionResumed = result.nativeSessionId === sessionId; }
      report.checks.nativeSessionReturned = typeof result.nativeSessionId === 'string' && !!result.nativeSessionId;
      sessionId = result.nativeSessionId;
      history.push({ requestId, prompt: request.prompt, body: parsed.plan.summary, context: [], evidenceIds: [] });
      context = { ...context, snapshot: parsed.preview, revision: context.revision + 1 };
    }
  }
} catch (error) {
  report.error = { code: error.code || 'unknown', message: redact(error.message) };
  const latest = report.turns.at(-1);
  // Diagnose authoritative native history only; never extract an arbitrary JSON substring from mixed output.
  if (latest?.nativeSessionId && !controller.signal.aborted) {
    try {
      const native = await runtime.readSession({ cwd: directory, sessionId: latest.nativeSessionId, signal: controller.signal });
      latest.nativeFinalBody = redact(native.messages.findLast(message => message.role === 'assistant')?.text ?? '');
      try { accepted(latest.nativeFinalBody, context); latest.nativeFinalPlanAccepted = true; } catch { latest.nativeFinalPlanAccepted = false; }
    } catch (historyError) { report.historyError = redact(historyError.message); }
  }
} finally {
  await runtime.close();
  try { report.checks.originalFilesUnchanged = digest(await readFile(join(directory, 'original.txt'))) === digest(sentinel); } catch { report.checks.originalFilesUnchanged = false; }
  await rm(directory, { recursive: true, force: true }); report.fixture.removedAfterVerification = true;
}
report.durationMs = Date.now() - started;
report.timedOut = controller.signal.aborted;
if (mode === '--run') {
  report.status = Object.values(report.checks).every(value => value !== false) ? 'passed' : report.request.attemptedModelCalls ? 'failed' : 'unavailable';
  const output = join(repository, 'docs/verification/board-agent'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'codex-probe.json'), JSON.stringify(report, null, 2) + '\n');
} else report.status = report.checks.parserSelfCheck && report.checks.originalFilesUnchanged ? 'passed' : 'failed';
console.log(JSON.stringify({ status: report.status, attemptedModelCalls: report.request.attemptedModelCalls, checks: report.checks, error: report.error, durationMs: report.durationMs }));
if (report.status !== 'passed') process.exitCode = 1;
