import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { compileAgentPrompt } from '../server/agents.mjs';
import { createCodexRuntime } from '../server/codex-runtime.mjs';

const mode = process.argv[2];
assert.ok(['--self-check', '--run'].includes(mode), 'Use --self-check or --run. Each --run makes one real request.');
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(repository, 'docs/verification/research-map/ai-existing-map');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-board-tree-')));
const digest = value => createHash('sha256').update(value).digest('hex');
const documents = [
  { id: 'demo-doc-a', title: '演示材料 A：实施记录', excerpts: [
    '项目把参数高效微调和全量更新放在同一组接口中，调用方传入模型路径、数据路径、配置文件和随机种子。两种方式会产生不同的可训练参数集合，记录中没有比较哪种方式更优。',
    '数据进入更新过程前先经过格式转换和检查。执行结束后写出参数文件、所用配置、数据清单摘要与运行日志；清单摘要用于区分输入的不同版本。',
    '团队把驱动兼容信息、CUDA 组件和 Python 包版本写入构建记录，运行时引用镜像摘要而非浮动标签。镜像负责准备依赖，启动命令由外部提交。',
  ] },
  { id: 'demo-doc-b', title: '演示材料 B：操作观察', excerpts: [
    '提交脚本读取配置后启动分布式进程，将输出写入带运行编号的目录。训练任务会周期性写检查点，但观察记录只证明检查点文件存在，没有记录中断后继续执行的结果。',
    '对比记录保留相同的数据清单、评测样本和随机种子，同时登记硬件型号、镜像摘要及参数配置。作者提醒相同随机种子并不意味着不同硬件上的结果完全一致。',
    '每次运行结束后，独立脚本在固定样本上计算任务得分，还记录处理吞吐、峰值显存和总用时。文档列出了这些量的计算入口，没有给出达标阈值、置信区间或多次运行的汇总方式。',
  ] },
  { id: 'demo-doc-c', title: '演示材料 C：验收便签', excerpts: [
    '维护者希望在更新某个包或基础镜像后，能把新运行与旧运行的产物、日志和测量值对应起来。当前只试过单机样例，多机下的退出行为没有做过演练。',
    '便签提出后续需要给出选择不同更新方式时的判断依据，以及在质量、耗时、显存之间如何取舍。负责人尚未确认硬性预算，记录没有任何真实业务测试分数。',
  ] },
];
let evidenceIndex = 0;
const evidence = documents.flatMap(document => document.excerpts.map((quote, pageIndex) => ({ evidenceId: `demo-evidence-${++evidenceIndex}`, documentId: document.id, documentHash: digest(document.excerpts.join('\n')), title: document.title, pageIndex, quote })));
const resources = [
  { ref: { kind: 'card', id: 'seed-question' }, title: '训练方案研究', body: '研究问题：如何选择更新方式，并得到可核查的验证结果？', evidenceIds: [] },
  { ref: { kind: 'card', id: 'seed-methods' }, title: '已有更新方式', body: '材料记录参数高效微调与全量更新共用输入接口，但没有证明谁更优。[1]', evidenceIds: ['demo-evidence-1'] },
  { ref: { kind: 'card', id: 'seed-runtime' }, title: '已有运行边界', body: '镜像固定依赖，外部提交命令启动进程；检查点文件存在不等于恢复验证已完成。[1][2]', evidenceIds: ['demo-evidence-3', 'demo-evidence-4'] },
];
const boardContext = { researchId: 'demo-research-tree', boardId: 'demo-board-tree', allowNewCards: true, revision: 3,
  snapshot: { board: { id: 'demo-board-tree', researchId: 'demo-research-tree', title: '我的训练研究图', layout: 'tree' },
    placements: resources.map((resource, index) => ({ id: `seed-placement-${index}`, boardId: 'demo-board-tree', resourceRef: resource.ref, x: index ? 390 : 50, y: index ? 80 + (index - 1) * 140 : 150, group: index ? '已有材料' : '研究问题', order: index ? index - 1 : 0, ...(index ? { parentPlacementId: 'seed-placement-0' } : {}) })),
    edges: [] }, resources, allowedEvidenceIds: evidence.map(item => item.evidenceId) };
const request = { requestId: 'board-tree-probe-v1', purpose: 'chat', context: evidence, history: [], boardContext,
  prompt: '请根据这些演示材料，补充我这张导图中的方法、运行条件和评估验证计划，让我能接着做研究。保留已有内容和我排好的层级顺序，没有依据的部分明确写成建议或待确认。' };
const report = { version: 1, executedAt: new Date().toISOString(), status: 'not-run', runtime: 'production compileAgentPrompt + createCodexRuntime + parseBoardPlan + previewBoardPlan', fixture: { synthetic: true, documents: 3, excerpts: evidence.length, existingCards: resources.length, existingMap: true }, request: { maxModelCalls: 1, attemptedModelCalls: 0, rpcTimeoutMs: 30000, generationDeadline: null, modelPolicy: 'Production default model and effort; no override or user configuration change', access: 'read-only' }, checks: {}, limitations: ['Programmatic checks validate structure and citation IDs, not whether every cited claim is entailed.', 'This one synthetic case does not establish reliability for all user materials.', 'This script validates existing-map expansion and its generated hierarchy; UI interaction, visual quality, and installation require separate verification.'] };
const runtime = createCodexRuntime({ rpcTimeoutMs: 30000 });
const started = Date.now();
let heartbeat, activityCount = 0, lastActivity = started, turn;
try {
  await mkdir(output, { recursive: true });
  for (const name of ['citations', 'board-structure', 'board-layout', 'board-history']) {
    const source = await readFile(join(repository, `src/domain/${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/from '(\.\/[^']+)'/g, "from '$1.mjs'");
    await writeFile(join(directory, `${name}.mjs`), compiled);
  }
  const { parseBoardPlan, previewBoardPlan, validateBoardContext, validateBoardSnapshot } = await import(pathToFileURL(join(directory, 'board-history.mjs')));
  validateBoardContext(boardContext, boardContext.researchId);
  const sample = { summary: '自检', title: '自检', layout: 'tree', nodes: [{ card: { title: '样例', body: '依据：接口接受配置。[1]', evidenceIds: [evidence[0].evidenceId] }, group: '样例' }], edges: [] };
  validateBoardSnapshot(previewBoardPlan(boardContext, parseBoardPlan(JSON.stringify(sample), boardContext)), boardContext.boardId, boardContext.researchId);
  assert.throws(() => parseBoardPlan(JSON.stringify({ ...sample, nodes: [{ ...sample.nodes[0], card: { ...sample.nodes[0].card, evidenceIds: ['outside-scope'] } }] }), boardContext));
  assert.throws(() => parseBoardPlan(JSON.stringify({ ...sample, nodes: [{ ...sample.nodes[0], card: { ...sample.nodes[0].card, body: '越界引用 [2]' } }] }), boardContext));
  assert.throws(() => parseBoardPlan(JSON.stringify({ ...sample, edges: [{ from: 0, to: 1, label: '无效' }] }), boardContext));
  report.checks.parserSelfCheck = true;
  if (mode === '--run') {
    const compiledPrompt = compileAgentPrompt(request);
    const manifest = JSON.stringify({ synthetic: true, documents, request }, null, 2) + '\n';
    await writeFile(join(directory, 'manifest.json'), manifest);
    await writeFile(join(directory, 'materials.md'), evidence.map(item => `${item.evidenceId}\n${item.quote}`).join('\n\n'));
    await writeFile(join(output, 'fixture.json'), manifest);
    await writeFile(join(output, 'compiled-prompt.txt'), compiledPrompt);
    report.promptSha256 = digest(compiledPrompt);
    report.request.attemptedModelCalls = 1;
    console.log(JSON.stringify({ event: 'started', output, generationDeadline: null }));
    heartbeat = setInterval(() => console.log(JSON.stringify({ event: 'activity', durationMs: Date.now() - started, activityCount, quietForMs: Date.now() - lastActivity, nativeSessionId: turn?.nativeSessionId, nativeTurnId: turn?.nativeTurnId })), 30000);
    const result = await runtime.run({ cwd: directory, materialCwd: directory, title: 'Papertrail synthetic existing research map expansion', requestId: request.requestId, skillIds: [], codex: { mode: 'chat', access: 'read-only' }, prompt: compiledPrompt,
      onActivity() { activityCount++; lastActivity = Date.now(); },
      onEvent(event) { if (event.type === 'session') { turn = { ...turn, nativeSessionId: event.nativeSessionId, ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}) }; console.log(JSON.stringify({ event: 'session', ...turn })); } },
    });
    report.turn = { ...turn, nativeSessionId: result.nativeSessionId, nativeTurnId: result.nativeTurnId, model: result.model, status: result.status, rawBody: result.body };
    await writeFile(join(output, 'raw-response.txt'), result.body);
    const plan = parseBoardPlan(result.body, boardContext), preview = previewBoardPlan(boardContext, plan);
    validateBoardSnapshot(preview, boardContext.boardId, boardContext.researchId);
    report.plan = plan; report.preview = preview;
    const cards = plan.nodes.filter(node => node.card).map(node => node.card);
    const used = new Set(cards.flatMap(card => card.evidenceIds));
    const groups = [...new Set(plan.nodes.map(node => node.group))];
    const retained = boardContext.snapshot.placements.map(old => preview.placements.find(p => p.id === old.id));
    const retainedIdentity = retained.every((p, index) => p && JSON.stringify(p.resourceRef) === JSON.stringify(boardContext.snapshot.placements[index].resourceRef));
    const retainedHierarchy = retained.every((p, index) => p && p.parentPlacementId === boardContext.snapshot.placements[index].parentPlacementId && p.order === boardContext.snapshot.placements[index].order);
    const adjacency = preview.placements.map(() => []);
    const indices = new Map(preview.placements.map((p, index) => [p.id, index]));
    const link = (from, to) => { adjacency[from].push(to); adjacency[to].push(from); };
    preview.placements.forEach((p, index) => { if (p.parentPlacementId) link(index, indices.get(p.parentPlacementId)); });
    plan.edges.forEach(edge => link(edge.from, edge.to));
    const visited = new Set([0]), queue = [0];
    for (let i = 0; i < queue.length; i++) for (const next of adjacency[queue[i]]) if (!visited.has(next)) { visited.add(next); queue.push(next); }
    const categories = { evidence: cards.filter(card => /依据[：:]/.test(card.body)), recommendation: cards.filter(card => /建议[：:]/.test(card.body)), unknown: cards.filter(card => /待验证[：:]|待确认[：:]/.test(card.body)), inference: cards.filter(card => /推断[：:]/.test(card.body)) };
    Object.assign(report.checks, { nativeCompleted: result.status === 'completed', productionParserAccepted: true, previewSnapshotAccepted: true,
      existingMapExpanded: cards.length > 0, existingIdentityRetained: retainedIdentity, existingHierarchyAndOrderRetained: retainedHierarchy,
      treeModeRetained: preview.board.layout === 'tree', generatedChildrenPresent: preview.placements.length > boardContext.snapshot.placements.length && preview.placements.some(p => !p.id.startsWith('seed-placement-') && p.parentPlacementId),
      connectedUndirected: visited.size === preview.placements.length, citationIdsInScope: [...used].every(id => boardContext.allowedEvidenceIds.includes(id)),
      recommendationsPresent: categories.recommendation.length > 0, openQuestionsPresent: categories.unknown.length > 0,
      originalFixtureUnchanged: digest(await readFile(join(directory, 'manifest.json'))) === digest(manifest) });
    report.metrics = { nodes: plan.nodes.length, existingNodes: resources.length, newCards: cards.length, semanticEdges: plan.edges.length, hierarchyEdges: preview.placements.filter(p => p.parentPlacementId).length,
      groups, citedEvidence: [...used], categoryCounts: Object.fromEntries(Object.entries(categories).map(([key, value]) => [key, value.length])) };
    report.status = Object.values(report.checks).every(Boolean) ? 'passed' : 'needs-review';
  } else report.status = 'passed';
} catch (error) {
  report.error = { code: error.code || 'unknown', message: error.message.replaceAll(directory, '<temporary-fixture>') };
  report.turn ||= { ...turn, ...(error.nativeSessionId ? { nativeSessionId: error.nativeSessionId } : {}), ...(error.nativeTurnId ? { nativeTurnId: error.nativeTurnId } : {}), ...(error.body ? { rawBody: error.body } : {}) };
  report.status = error.code === 'delivery_unknown' || error.code === 'stop_unconfirmed' ? 'delivery_unknown' : error.code === 'timeout' || !report.turn?.nativeTurnId ? 'unavailable' : 'needs-review';
} finally {
  clearInterval(heartbeat);
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
  report.fixture.temporaryDirectoryRemoved = true;
  report.durationMs = Date.now() - started;
  if (mode === '--run') await writeFile(join(output, 'codex-probe.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, request: report.request, checks: report.checks, metrics: report.metrics, error: report.error, durationMs: report.durationMs }));
if (report.status !== 'passed') process.exitCode = 1;
