import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createResearchHandler } from '../../../../server/research.mjs';
import { createCodexRuntime } from '../../../../server/codex-runtime.mjs';

// One real generation per execution; rerunning requires an intentional new evidence file.
const output = new URL('./result.json', import.meta.url);
try { await access(output); throw new Error('result.json already exists; this probe will not repeat a paid generation.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const started = Date.now(), startedAt = new Date(started).toISOString();
const request = { requestId: 'public-literature-smoke-20261021', researchId: 'synthetic-public-research', connectionId: 'codex',
  prompt: '请明确调用 search_literature，以 retrieval augmented generation evidence selection 为关键词找新论文。仅列出工具实际返回的前 2 篇题名和 DOI 或来源 URL，并注明尚未读 PDF。不要提交文稿，不要读取本机文件，不要执行 shell，不要使用其他工具，也不要改写检索词。', sources: [], history: [] };
const calls = [], events = [];
const evidence = { startedAt, cliVersion: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(), nodeVersion: process.version,
  scope: 'One synthetic public request; no application workspace, user research, library writes, PDF reads, credentials inspection or model fixtures.',
  literatureTransport: 'Existing loopback OpenAlex HTTP service at 127.0.0.1:8787; only the model-selected short query and optional year filters are forwarded.',
  limits: { totalDeadlineMs: 180000, researchInactivityMs: 120000, upstreamMs: 20000, maximumSearchCalls: 3 }, request, calls, events };
const runtime = createCodexRuntime({ env: process.env });
let handler;
const server = createServer((req, res) => { handler(req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end(); } }).catch(() => { if (!res.writableEnded) res.end(); }); });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
handler = createResearchHandler({ env: process.env, ports: [port], timeoutMs: 120000,
  runtimes: { codex: { run(input) { evidence.registeredTools = input.researchTools.definitions.map(item => item.name); return runtime.run(input); } } },
  searchLiterature: async (input, { signal } = {}) => {
    const call = { elapsedMs: Date.now() - started, input: structuredClone(input) };
    calls.push(call);
    const response = await fetch('http://127.0.0.1:8787/api/ai/literature/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)].filter(Boolean)) });
    const result = await response.json();
    call.httpStatus = response.status;
    call.completedMs = Date.now() - started;
    if (!response.ok) { call.errorCode = result.code; throw Object.assign(new Error(typeof result.error === 'string' ? result.error : 'Public literature lookup failed.'), { code: result.code, status: response.status }); }
    call.candidateCount = result.candidates?.length;
    return result;
  },
});
try {
  const response = await fetch(`http://127.0.0.1:${port}/api/ai/research/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(180000) });
  evidence.httpStatus = response.status;
  evidence.contentType = response.headers.get('content-type');
  if (!response.body) throw new Error('No event stream.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  const consume = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'done') { event.nativeSessionObserved = typeof event.nativeSessionId === 'string'; delete event.nativeSessionId; }
    events.push({ elapsedMs: Date.now() - started, ...event });
    if (event.type === 'literature') process.stdout.write(`literature ${event.search.status}\n`);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally { reader.releaseLock(); }
  const found = events.find(event => event.type === 'literature' && event.search.status === 'done' && event.search.candidates.length >= 2);
  const answer = events.filter(event => event.type === 'delta').map(event => event.text).join('');
  evidence.answer = answer;
  evidence.checks = { actualSearchCalled: calls.length > 0, actualTwoCandidates: !!found,
    firstTwoTitlesInAnswer: !!found && found.search.candidates.slice(0, 2).every(item => answer.includes(item.title)),
    firstTwoLinksInAnswer: !!found && found.search.candidates.slice(0, 2).every(item => answer.includes(item.url) || item.doi && answer.includes(item.doi)),
    cleanDone: events.at(-1)?.type === 'done', noArtifact: events.every(event => event.type !== 'artifact'), noPdfReads: events.at(-1)?.type === 'done' && events.at(-1).readPages.length === 0,
    registeredOnlyResearchTools: JSON.stringify(evidence.registeredTools) === JSON.stringify(['search_literature', 'search_sources', 'read_page', 'submit_result']) };
  evidence.success = Object.values(evidence.checks).every(value => value === true);
} catch (error) {
  evidence.success = false;
  evidence.failure = { name: error.name, code: typeof error.code === 'string' ? error.code : undefined,
    message: error.name === 'TimeoutError' ? 'The one-shot 180 second public smoke deadline elapsed; no automatic retry.' : 'Public research smoke did not complete; inspect the filtered stream and call outcomes.' };
} finally {
  handler.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await runtime.close();
  evidence.finishedAt = new Date().toISOString(); evidence.elapsedMs = Date.now() - started;
  await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
}
process.stdout.write(JSON.stringify({ success: evidence.success, elapsedMs: evidence.elapsedMs, calls: calls.length, lastEvent: events.at(-1)?.type, checks: evidence.checks, failure: evidence.failure }) + '\n');
if (!evidence.success) process.exitCode = 1;
