import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { expectedAssets } from './release.mjs';
import { BRANCH, REPOSITORY, SOURCE, TAG, previewReleaseNotes, publishVerified, requireConfiguredSource, requireFixedMain, selectDispatchedRun, verifyPublished } from './publish-preview-once.mjs';

const hash = content => createHash('sha256').update(content).digest('hex');
const runFixture = () => ({ id: 71, workflow_id: 22, path: '.github/workflows/release.yml', event: 'workflow_dispatch',
  head_branch: 'main', head_sha: SOURCE, head_repository: { full_name: REPOSITORY },
  created_at: '2026-10-19T00:00:01Z', status: 'completed', conclusion: 'success' });

function releaseFixture() {
  const names = Object.values(expectedAssets(TAG)).flat();
  const expected = names.map(name => ({ name, digest: `sha256:${hash(name)}`, size: Buffer.byteLength(name) }));
  const manifest = Buffer.from(expected.map(asset => `${asset.digest.slice(7)}  ${asset.name}`).sort().join('\n') + '\n');
  expected.push({ name: 'SHA256SUMS', digest: `sha256:${hash(manifest)}`, size: manifest.length });
  return { expected, manifest, release: { id: 9, tag_name: TAG, draft: true, prerelease: true,
    body: `Papertrail ${TAG}\n\nSource commit: ${SOURCE}\n`, html_url: `https://github.com/${REPOSITORY}/releases/tag/${TAG}`,
    assets: expected.map((asset, index) => ({ ...asset, id: index + 1 })) } };
}

function apiFixture({ run = runFixture(), release, tagSha = SOURCE, mainSha = SOURCE, manifest } = {}) {
  const writes = [];
  const api = async (path, options = {}) => {
    if (options.method && options.method !== 'GET') writes.push({ path, ...options });
    if (path === '/git/ref/heads/main') return { object: { sha: mainSha } };
    if (path.startsWith('/actions/runs/')) return structuredClone(run);
    if (path.startsWith('/git/ref/tags/')) return { object: { type: 'commit', sha: tagSha } };
    if (options.binary) return manifest;
    if (path === `/releases/${release.id}`) {
      if (options.method === 'PATCH') Object.assign(release, options.body);
      return structuredClone(release);
    }
    throw new Error(`Unexpected fixture request ${path}`);
  };
  return { api, writes };
}

test('source template cannot run before the final merged commit is configured', () => {
  assert.throws(() => requireConfiguredSource('0'.repeat(40)), /placeholder/);
  for (const source of ['', 'a'.repeat(39), 'A'.repeat(40), 'main']) assert.throws(() => requireConfiguredSource(source), /full lowercase commit SHA/);
  requireConfiguredSource('1'.repeat(40));
  const result = spawnSync(process.execPath, [new URL('./publish-preview-once.mjs', import.meta.url).pathname], { env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, SOURCE === '0'.repeat(40) ? /SOURCE placeholder/ : /Unexpected repository/);
});

test('workflow is restricted to the versioned helper branch with enough time for release checks', () => {
  const workflow = readFileSync(new URL('../workflows/publish-v0.1.9-once.yml', import.meta.url), 'utf8');
  assert.equal(TAG, 'v0.1.9');
  assert.equal(BRANCH, 'codex/publish-v0.1.9');
  assert.match(workflow, /branches: \['codex\/publish-v0\.1\.9'\]/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/codex\/publish-v0\.1\.9'/);
  assert.match(workflow, /ref: '?([a-f0-9]{40})'?/);
  assert.equal(workflow.match(/ref: '?([a-f0-9]{40})'?/)[1], SOURCE);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /timeout-minutes: 90/);
  assert.doesNotMatch(workflow, /v0\.1\.6|v016|v0\.1\.8|v018|persist-credentials: true/);
});

test('main must still equal the fixed source', async () => {
  const calls = [];
  const api = sha => async (path, options) => {
    calls.push({ path, ...options });
    return { object: { sha } };
  };
  await requireFixedMain(api(SOURCE));
  await assert.rejects(requireFixedMain(api('a'.repeat(40))), /Main changed/);
  assert(calls.every(call => call.path === '/git/ref/heads/main' && !call.method));
});

test('dispatch identity excludes baseline, wrong workflow/repository/source/branch/event and old runs', () => {
  const run = runFixture();
  const input = { baseline: new Set([70]), workflowId: 22, dispatchedAt: Date.parse('2026-10-19T00:00:01Z') };
  const incorrect = [{ id: 70 }, { workflow_id: 23 }, { path: '.github/workflows/test.yml' },
    { event: 'push' }, { head_branch: BRANCH }, { head_sha: 'a'.repeat(40) },
    { head_repository: { full_name: 'someone/Read-paper' } }, { created_at: '2026-10-19T00:00:00Z' }];
  assert.equal(selectDispatchedRun(incorrect.map((change, index) => ({ ...run, id: 80 + index, ...change })), input), undefined);
  assert.deepEqual(selectDispatchedRun([run], input), run);
  assert.throws(() => selectDispatchedRun([run, { ...run, id: 72 }], input), /More than one/);
});

test('only a successful, complete, fixed-source workflow can publish', async () => {
  for (const change of [{ status: 'in_progress', conclusion: null }, { conclusion: 'failure' },
    { conclusion: 'cancelled' }, { head_sha: 'b'.repeat(40) }, { id: 72 }, { head_branch: BRANCH },
    { event: 'push' }, { path: '.github/workflows/test.yml' }, { head_repository: { full_name: 'someone/repo' } }]) {
    const { release, expected } = releaseFixture();
    const { api, writes } = apiFixture({ release, run: { ...runFixture(), ...change } });
    await assert.rejects(publishVerified({ api, runId: 71, releaseId: 9, expected }));
    assert.deepEqual(writes, [], JSON.stringify(change));
  }
});

test('moved tag, wrong source/tag/preview and missing or corrupt assets reject before publication', async () => {
  const cases = [
    ({ release }) => { release.tag_name = 'v0.1.5'; },
    ({ release }) => { release.body = `Source commit: ${'a'.repeat(40)}`; },
    ({ release }) => { release.body += `Source commit: ${SOURCE}\n`; },
    ({ release }) => { release.prerelease = false; },
    ({ release }) => { release.draft = false; },
    ({ release }) => { release.assets.pop(); },
    ({ release }) => { release.assets[0].digest = `sha256:${'a'.repeat(64)}`; },
    ({ release }) => { delete release.assets[0].digest; },
    ({ release }) => { release.assets[0].size++; },
    ({ release }) => { release.assets.push({ ...release.assets[0] }); },
  ];
  for (const change of cases) {
    const fixture = releaseFixture();
    change(fixture);
    const { api, writes } = apiFixture(fixture);
    await assert.rejects(publishVerified({ api, runId: 71, releaseId: 9, expected: fixture.expected }));
    assert.deepEqual(writes, []);
  }
  const fixture = releaseFixture();
  const { api, writes } = apiFixture({ ...fixture, tagSha: 'f'.repeat(40) });
  await assert.rejects(publishVerified({ api, runId: 71, releaseId: 9, expected: fixture.expected }), /fixed source/);
  assert.deepEqual(writes, []);
});

test('publication preserves tag and preview, disables latest and verifies the resulting public release', async () => {
  const fixture = releaseFixture();
  const { api, writes } = apiFixture(fixture);
  const result = await publishVerified({ api, runId: 71, releaseId: 9, expected: fixture.expected });
  assert.equal(result.draft, false);
  assert.equal(writes.length, 1);
  const publication = writes[0];
  assert.equal(publication.method, 'PATCH');
  assert.equal(publication.body.draft, false);
  assert.equal(publication.body.prerelease, true);
  assert.equal(publication.body.tag_name, TAG);
  assert.equal(publication.body.make_latest, 'false');
  assert.match(publication.body.body, /Codex 原生连续对话/);
  assert.match(publication.body.body, /发行运行 #71/);
  assert.match(publication.body.body, /本次发行检查已完整通过/);
  assert.match(publication.body.body, /修复受控复现的输入同步竞态/);
  assert.match(publication.body.body, /保留原有草稿、会话状态和重启恢复的严格检查/);
  assert.match(publication.body.body, /notarization/);
  assert.match(publication.body.body, /仍需在本机安装并登录 Codex/);
  assert.match(publication.body.body, /拖动标题移动、拖动右下角调整大小/);
  assert.match(publication.body.body, /没有自动更新/);
  assert.match(publication.body.body, /未触发自动阈值压缩/);
  assert.deepEqual(publication.body.body.split('\n').filter(line => line.startsWith('Source commit: ')), [`Source commit: ${SOURCE}`]);
  assert.doesNotMatch(publication.body.body, /shared Pi runtime|successful live model answer has not been verified/);
  assert.doesNotMatch(publication.body.body, /Do not publish this draft/);
  assert.doesNotMatch(publication.body.body, /待补充|尚不声称|Intel.*唯一根因/);
});

test('main moving during the build prevents the final publication write', async () => {
  const fixture = releaseFixture();
  const { api, writes } = apiFixture({ ...fixture, mainSha: 'f'.repeat(40) });
  await assert.rejects(publishVerified({ api, runId: 71, releaseId: 9, expected: fixture.expected }), /Main changed/);
  assert.deepEqual(writes, []);
});

test('notes have one fixed source guard and do not claim an unobserved CI result', () => {
  const notes = previewReleaseNotes();
  assert.deepEqual(notes.split('\n').filter(line => line.startsWith('Source commit: ')), [`Source commit: ${SOURCE}`]);
  assert.doesNotMatch(notes, /发行运行 #|发行检查已完整通过|CI 全部通过|全量全部通过|待补充|尚不声称/);
  assert.match(notes, /安装器人工验收/);
  assert.match(notes, /修复受控复现的输入同步竞态/);
  assert.match(notes, /0\.1\.9 本机代码检查、业务单测、服务测试和桌面单测通过/);
  assert.match(notes, /运行 #39240037338.*actions\/runs\/39240037338/);
  assert.match(notes, /e2905e914472a93f9d14c86d218a0131674ac4ba/);
  assert.match(notes, /各重复 10 次，20\/20 通过/);
  assert.match(notes, /未添加诊断埋点/);
  assert.match(notes, /关闭前 DOM\/状态及重启后的严格断言/);
  assert.match(notes, /这是打包应用验证，不代表人工安装器验收/);
  assert.match(notes, /0\.1\.8 候选阶段的真实 Codex 探针/);
  assert.doesNotMatch(notes, /Papertrail-0\.1\.8|blob\/v0\.1\.8/);
});

test('an existing public release verifies manifest and source without writes', async () => {
  const fixture = releaseFixture();
  fixture.release.draft = false;
  const { api, writes } = apiFixture(fixture);
  await verifyPublished({ api, release: fixture.release });
  assert.deepEqual(writes, []);
  fixture.release.assets[0].digest = `sha256:${'f'.repeat(64)}`;
  await assert.rejects(verifyPublished({ api, release: fixture.release }), /SHA-256 mismatch/);
  assert.deepEqual(writes, []);
});

test('a corrupt checksum manifest or duplicate source cannot validate an existing release', async () => {
  const fixture = releaseFixture();
  fixture.release.draft = false;
  const { api } = apiFixture({ ...fixture, manifest: Buffer.from('invalid') });
  await assert.rejects(verifyPublished({ api, release: fixture.release }), /Invalid published checksum/);
  fixture.release.body += `Source commit: ${SOURCE}\n`;
  const validApi = apiFixture(fixture).api;
  await assert.rejects(verifyPublished({ api: validApi, release: fixture.release }), /unknown source/);
});
