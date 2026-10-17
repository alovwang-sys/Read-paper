import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { writeProjectFiles } from '../server/project-files.mjs';
import { createCodexRuntime } from '../server/codex-runtime.mjs';

// Explicit --run permits exactly one real model request; --self-check never calls a model.
const mode = process.argv[2];
if (!['--run', '--self-check'].includes(mode)) {
  console.log('Usage: node scripts/verify-research-directory-codex.mjs --self-check | --run');
  process.exit(0);
}
const digest = value => createHash('sha256').update(value).digest('hex');
const entry = (path, content, encoding = 'utf8') => ({ path, content, encoding, hash: digest(Buffer.from(content, encoding)) });
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(repository, 'docs/verification/research-directory');
const root = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-directory-codex-')));
const expectedTitle = `Papertrail Directory Probe ${randomUUID().slice(0, 8)}`;
const report = {
  version: 1, executedAt: new Date().toISOString(), status: 'not-run',
  runtime: 'server/codex-runtime.mjs production createCodexRuntime adapter',
  fixture: { data: 'synthetic-only', directory: '<temporary-research-directory>', entry: 'Papertrail/README.md', card: 'Papertrail/cards/card-probe.md', expectedTitle },
  request: { attemptedModelCalls: 0, timeoutMs: 60_000, access: 'read-only', network: 'disabled', skills: 'none', externalDesktopUI: 'not-checked' },
  checks: { filesMaterialized: false, realReadCommandSucceeded: false, realAnswerMatchesCard: false, nativeSessionReturned: false, sameCwdListed: false, sameCwdRead: false, nativeHistoryAnswerMatches: false, originalFilesUnchanged: false },
  toolEvidence: [], nativeSessionId: null, nativeTurnId: null,
};
const redact = value => String(value).replaceAll(root, '<temporary-research-directory>').replaceAll(homedir(), '<user-home>').slice(0, 1200);
let payload;
let controller;
let timer;
const started = Date.now();
try {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 200]).drawText('Synthetic Papertrail directory probe.');
  const pdfBytes = Buffer.from(await pdf.save());
  payload = { files: [
    entry('README.md', '# Synthetic research\n\nOpen [probe card](cards/card-probe.md).\n\nThe Markdown conversation archive is readable material only. Native Codex Session logs stay in the Codex runtime; nativeSessionId is restored by that runtime.\n'),
    entry('research.json', JSON.stringify({ format: 'papertrail-research', version: 1, research: { id: 'research-probe', title: 'Synthetic research only' }, documents: [{ id: 'document-probe', path: 'library/document-probe.pdf', hash: digest(pdfBytes) }], cards: [{ id: 'card-probe', path: 'cards/card-probe.md' }] }, null, 2)),
    entry('cards/card-probe.md', `# ${expectedTitle}\n\nThis self-authored card contains no real user data.\n`),
    entry('library/document-probe.pdf', pdfBytes.toString('base64'), 'base64'),
  ] };
  const written = await writeProjectFiles({ path: root, projectId: 'project-probe', researchId: 'research-probe' }, payload);
  assert.equal(written.files, 4);
  for (const file of payload.files) assert.equal(digest(await readFile(join(root, 'Papertrail', file.path))), file.hash);
  assert.equal((await PDFDocument.load(await readFile(join(root, 'Papertrail/library/document-probe.pdf')))).getPageCount(), 1);
  report.checks.filesMaterialized = true;
  if (mode === '--self-check') {
    console.log('Probe self-check passed: synthetic Markdown/JSON/PDF materialized and hashes verified; no model request.');
  } else {
    const { stdout } = await promisify(execFile)('codex', ['--version'], { timeout: 5000, maxBuffer: 4096 });
    report.localCliVersion = stdout.trim().slice(0, 100);
    const runtime = createCodexRuntime({ rpcTimeoutMs: 10_000 });
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), report.request.timeoutMs);
    report.request.attemptedModelCalls = 1;
    let result;
    try {
      result = await runtime.run({
        cwd: root, materialCwd: root, signal: controller.signal,
        title: 'Papertrail synthetic research directory verification',
        // The answer is intentionally absent from the prompt: it must come from the saved file.
        prompt: '请只读当前研究目录中的 Papertrail/cards/card-probe.md。最终只返回该卡片第一行的标题，去掉开头的 # 和空格，不附加其他文字。不要修改文件，不要访问研究目录外的数据，不要联网。',
        onEvent(event) {
          if (event.type === 'session') {
            if (event.nativeSessionId) report.nativeSessionId = event.nativeSessionId;
            if (event.nativeTurnId) report.nativeTurnId = event.nativeTurnId;
          }
          if (event.type === 'progress' && event.kind === 'tool' && report.toolEvidence.length < 12) {
            report.toolEvidence.push({ toolName: event.toolName, status: event.status, ...(event.command ? { command: redact(event.command) } : {}), ...(Number.isInteger(event.exitCode) ? { exitCode: event.exitCode } : {}), ...(event.output ? { outputContainsExpectedTitle: event.output.includes(expectedTitle) } : {}) });
          }
        },
      });
      report.answer = redact(result.body);
      // The production stream joins commentary and final messages; native history below checks the exact final answer.
      report.checks.realAnswerMatchesCard = result.body.trim().endsWith(expectedTitle);
      report.observations = { streamedBodyExactlyTitle: result.body.trim() === expectedTitle };
      report.nativeSessionId = result.nativeSessionId;
      report.nativeTurnId = result.nativeTurnId;
      report.model = result.model;
    } catch (error) {
      report.error = { stage: 'production-runtime-run', code: error.code || 'unknown', message: redact(error.message) };
    }
    report.checks.realReadCommandSucceeded = report.toolEvidence.some(item => item.toolName === 'commandExecution' && item.status === 'done' && item.exitCode === 0 && item.outputContainsExpectedTitle);
    report.checks.nativeSessionReturned = typeof report.nativeSessionId === 'string' && report.nativeSessionId.length > 0;
    if (report.nativeSessionId && !controller.signal.aborted) {
      try {
        const listed = await runtime.listSessions({ cwd: root, signal: controller.signal });
        report.checks.sameCwdListed = listed.sessions.some(item => item.id === report.nativeSessionId);
        const history = await runtime.readSession({ cwd: root, sessionId: report.nativeSessionId, signal: controller.signal });
        report.checks.sameCwdRead = history.id === report.nativeSessionId;
        report.checks.nativeHistoryAnswerMatches = history.messages.findLast(item => item.role === 'assistant')?.text.trim() === expectedTitle;
        report.nativeHistoryMessageCount = history.messages.length;
      } catch (error) {
        report.historyError = { code: error.code || 'unknown', message: redact(error.message) };
      }
    }
    report.timedOut = controller.signal.aborted;
  }
} catch (error) {
  report.error = { stage: report.checks.filesMaterialized ? 'local-codex-availability' : 'synthetic-fixture', code: error.code || 'unknown', message: redact(error.message) };
} finally {
  if (timer) clearTimeout(timer);
  if (payload) {
    report.checks.originalFilesUnchanged = true;
    for (const file of payload.files) {
      try { if (digest(await readFile(join(root, 'Papertrail', file.path))) !== file.hash) report.checks.originalFilesUnchanged = false; }
      catch { report.checks.originalFilesUnchanged = false; }
    }
  }
  // Only our temporary synthetic files are removed; native Codex history is left untouched.
  await rm(root, { recursive: true, force: true });
  report.fixture.removedAfterVerification = true;
}
if (mode === '--run') {
  report.durationMs = Date.now() - started;
  report.status = Object.values(report.checks).every(Boolean) ? 'passed' : report.request.attemptedModelCalls ? 'failed' : 'unavailable';
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'codex-files-probe.json'), JSON.stringify(report, null, 2) + '\n');
  const rows = Object.entries(report.checks).map(([name, passed]) => `| ${name} | ${passed ? '通过' : '未通过'} |`).join('\n');
  await writeFile(join(output, 'codex-files-probe.md'), `# 真实 Codex 研究目录探针\n\n执行时间：${report.executedAt}。结果：**${report.status}**。本次仅尝试 ${report.request.attemptedModelCalls} 次真实模型请求；总执行 ${report.durationMs} ms，模型/历史操作共用 60 秒终止预算。\n\n使用生产 \`createCodexRuntime\`，只读临时合成研究中的卡片，标题为随机值且未放入问题。生成的 README、research.json、卡片和单页 PDF 先经生产 \`writeProjectFiles\` 写入。未使用任何真实用户资料。\n\n| 检查 | 结果 |\n| --- | --- |\n${rows}\n\n本机版本：${report.localCliVersion || '未取得'}。原生 Session ID：${report.nativeSessionId || '未取得'}。\n\n${report.error ? `失败阶段：${report.error.stage}；${report.error.code}：${report.error.message}\n\n` : ''}${report.historyError ? `历史检查错误：${report.historyError.code}：${report.historyError.message}\n\n` : ''}同目录列表与读取均使用生产适配器，适配器核对原生 thread.cwd 后才返回会话；通过标准要求真实文件读取、回答、原生 ID、同 cwd list/read 与原生历史的精确最终回答同时匹配。生产流会合并 commentary 与最终回答，因此流文本只要求以实际标题结尾，原生历史仍要求最终 assistant 消息严格等于标题。\n\n${report.observations?.streamedBodyExactlyTitle === false ? '本次观察到流正文包含“我会只读取指定卡片的第一行。”随后追加正确标题；原生历史保留两条 assistant 消息，最终消息精确匹配标题。初版探针将合并后的流正文也要求完全等于标题，随后仅根据这次已保存结果修正检查标准，没有再次请求模型。\n\n' : ''}没有复制 Markdown 归档来冒充原生 Session 恢复，也没有发起第二轮模型请求。\n\n临时研究文件已清理；Codex 自己创建的合成测试会话保留在原生存储。未修改用户 Codex 配置、既有会话或 daemon。未操作独立 Codex 桌面 UI，因此桌面中的项目切换/展示和第二轮原生 resume 仍未验收。\n\n重跑会再次产生真实模型请求：\`node scripts/verify-research-directory-codex.mjs --run\`。只校验本地合成文件而不调用模型：\`--self-check\`。脱敏细节见 [JSON 记录](codex-files-probe.json)。\n`);
  console.log(JSON.stringify({ status: report.status, checks: report.checks, nativeSessionId: report.nativeSessionId, error: report.error, historyError: report.historyError, durationMs: report.durationMs }));
  if (report.status !== 'passed') process.exitCode = 1;
} else if (!report.checks.filesMaterialized || !report.checks.originalFilesUnchanged) {
  console.error('Probe self-check failed.');
  process.exitCode = 1;
}
