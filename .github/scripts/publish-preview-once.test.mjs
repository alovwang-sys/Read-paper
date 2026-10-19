import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { expectedAssets } from './release.mjs';
import { BRANCH, REPOSITORY, SOURCE, TAG, publishVerified, requireFixedMain, selectDispatchedRun, verifyPublished } from './publish-preview-once.mjs';

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

function apiFixture({ run = runFixture(), release, tagSha = SOURCE, manifest } = {}) {
  const writes = [];
  const api = async (path, options = {}) => {
    if (options.method && options.method !== 'GET') writes.push({ path, ...options });
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

test('main must still equal the explicitly approved fixed source', async () => {
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
  assert.match(publication.body.body, /successful live model answer has not been verified/);
  assert.match(publication.body.body, /notarization/);
  assert.doesNotMatch(publication.body.body, /Do not publish this draft/);
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
