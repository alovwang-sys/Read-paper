import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureManualTag, expectedAssets, prepareAssets, releaseNotes, updateDraft, verifySource } from './release.mjs';

export const REPOSITORY = 'alovwang-sys/Read-paper';
export const TAG = 'v0.1.6';
export const SOURCE = 'ef5f104abee792daf836d3e00c411bcb8f035b71';
export const BRANCH = 'codex/publish-v0.1.6';
const workflowPath = '.github/workflows/release.yml';
const artifactNames = Object.keys(expectedAssets(TAG)).map(target => `desktop-release-${target}`).sort();
const assetNames = [...Object.values(expectedAssets(TAG)).flat(), 'SHA256SUMS'].sort();
const digest = content => createHash('sha256').update(content).digest('hex');

export async function requireFixedMain(api) {
  assert.equal((await api('/git/ref/heads/main')).object?.sha, SOURCE, 'Main changed; this fixed release requires review');
}

export function selectDispatchedRun(runs, { baseline, workflowId, dispatchedAt }) {
  const matches = runs.filter(run => !baseline.has(run.id) && run.workflow_id === workflowId && run.path === workflowPath &&
    run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_sha === SOURCE &&
    run.head_repository?.full_name === REPOSITORY && Date.parse(run.created_at) >= dispatchedAt);
  assert(matches.length <= 1, 'More than one new release run matches this dispatch; refusing to choose');
  return matches[0];
}

export function requireSuccessfulRun(run) {
  assert.equal(run.event, 'workflow_dispatch', 'Unexpected release run event');
  assert.equal(run.path, workflowPath, 'Unexpected release workflow');
  assert.equal(run.head_branch, 'main', 'Release must run from main');
  assert.equal(run.head_sha, SOURCE, 'Release run belongs to another source');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Release run belongs to another repository');
  assert.equal(run.status, 'completed', 'Release workflow is still running');
  assert.equal(run.conclusion, 'success', 'Release workflow did not succeed');
}

export function requireRelease(release, expected, draft) {
  assert.equal(release.tag_name, TAG, 'Unexpected release tag');
  assert.equal(release.draft, draft, draft ? 'Release is no longer a draft' : 'Release is not public');
  assert.equal(release.prerelease, true, 'Release must remain an unsigned preview');
  const sources = release.body?.split('\n').filter(line => line.startsWith('Source commit: '));
  assert.deepEqual(sources, [`Source commit: ${SOURCE}`], 'Release belongs to a different or unknown source');
  assert.deepEqual(release.assets?.map(asset => asset.name).sort(), assetNames, 'Exactly eight release assets are required');
  for (const asset of release.assets) {
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `Invalid size for ${asset.name}`);
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Missing SHA-256 for ${asset.name}`);
    const prepared = expected.find(item => item.name === asset.name);
    assert(prepared, `Unexpected asset ${asset.name}`);
    assert.equal(asset.digest, prepared.digest, `SHA-256 mismatch for ${asset.name}`);
    if (prepared.size !== undefined) assert.equal(asset.size, prepared.size, `Size mismatch for ${asset.name}`);
  }
}

async function requireTag(api) {
  let { object } = await api(`/git/ref/tags/${TAG}`);
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    assert.match(object.sha, /^[a-f0-9]{40}$/);
    ({ object } = await api(`/git/tags/${object.sha}`));
  }
  assert(object?.type === 'commit' && object.sha === SOURCE, 'Remote release tag does not match the fixed source');
}

export async function publishVerified({ api, runId, releaseId, expected }) {
  const run = await api(`/actions/runs/${runId}`);
  assert.equal(run.id, runId, 'Unexpected release run');
  requireSuccessfulRun(run);
  await requireTag(api);
  const release = await api(`/releases/${releaseId}`);
  requireRelease(release, expected, true);
  const body = releaseNotes(TAG, SOURCE).replace('Do not publish this draft while the workflow is running.\n', '') +
    '\nThis version adds the inline reading assistant and shared Pi runtime. Model configuration uses the reader’s own credentials; a successful live model answer has not been verified.\n';
  const published = await api(`/releases/${releaseId}`, { method: 'PATCH', body: {
    draft: false, prerelease: true, tag_name: TAG, make_latest: 'false', body,
  } });
  assert.equal(published.id, releaseId, 'Unexpected published release');
  const current = await api(`/releases/${releaseId}`);
  requireRelease(current, expected, false);
  await requireTag(api);
  return current;
}

export async function verifyPublished({ api, release }) {
  await requireTag(api);
  const sums = release.assets?.find(asset => asset.name === 'SHA256SUMS');
  assert(sums?.id, 'Published release is missing checksums');
  const content = await api(`/releases/assets/${sums.id}`, { binary: true });
  const expected = [{ name: 'SHA256SUMS', digest: `sha256:${digest(content)}`, size: content.length }];
  for (const line of content.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match, 'Invalid published checksum manifest');
    expected.push({ name: match[2], digest: `sha256:${match[1]}` });
  }
  assert.deepEqual(expected.map(item => item.name).sort(), assetNames, 'Unexpected checksum manifest assets');
  requireRelease(await api(`/releases/${release.id}`), expected, false);
  await requireTag(api);
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected repository');
  assert.equal(process.env.GITHUB_REF, `refs/heads/${BRANCH}`, 'Unexpected publishing branch');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Expected a branch push');
  const helperSha = process.env.GITHUB_SHA;
  assert.match(helperSha ?? '', /^[a-f0-9]{40}$/, 'Missing helper commit');
  const sourceDirectory = resolve('release-source');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git(process.cwd(), 'rev-parse', 'HEAD'), helperSha, 'Publishing checkout changed');
  assert.equal(git(sourceDirectory, 'rev-parse', 'HEAD'), SOURCE, 'Release source checkout changed');
  const token = process.env.GH_TOKEN;
  assert(token, 'Missing Actions token');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
  const api = async (path, { method = 'GET', body, binary = false } = {}) => {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json', ...(binary ? { Accept: 'application/octet-stream' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `GitHub ${method} ${path} failed (${response.status})`);
    return response.status === 204 ? null : binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  const list = async (path, key) => {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const entries = key ? result[key] : result;
      assert(Array.isArray(entries), 'Unexpected paginated GitHub response');
      items.push(...entries);
      if (entries.length < 100) return items;
    }
  };
  await requireFixedMain(api);
  let release = (await list('/releases')).find(item => item.tag_name === TAG);
  let run;
  const alreadyPublished = release && !release.draft;
  if (alreadyPublished) await verifyPublished({ api, release });
  else {
    await ensureManualTag({ tag: TAG, ref: 'refs/heads/main', sha: SOURCE, repository: REPOSITORY, token, cwd: sourceDirectory, request });
    git(sourceDirectory, 'fetch', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`);
    assert.equal(verifySource({ tag: TAG, event: 'workflow_dispatch', ref: 'refs/heads/main', eventSha: SOURCE, cwd: sourceDirectory }).sha, SOURCE);
    const workflow = await api('/actions/workflows/release.yml');
    assert.equal(workflow.path, workflowPath, 'Unexpected release workflow path');
    assert.equal(workflow.state, 'active', 'Release workflow is disabled');
    const runPath = `/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main`;
    const baseline = new Set((await list(runPath, 'workflow_runs')).map(item => item.id));
    await requireFixedMain(api);
    const dispatchedAt = Math.floor(Date.now() / 1000) * 1000;
    await api(`/actions/workflows/${workflow.id}/dispatches`, { method: 'POST', body: { ref: 'main', inputs: { tag: TAG } } });
    const deadline = Date.now() + 45 * 60_000;
    while (Date.now() < deadline) {
      const candidate = selectDispatchedRun(await list(runPath, 'workflow_runs'), { baseline, workflowId: workflow.id, dispatchedAt });
      if (candidate) {
        if (run) assert.equal(candidate.id, run.id, 'Dispatched release run changed');
        else console.log(`Selected release workflow: https://github.com/${REPOSITORY}/actions/runs/${candidate.id}`);
        run = candidate;
        if (run.status === 'completed') { requireSuccessfulRun(run); break; }
      }
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    assert(run?.status === 'completed', 'Timed out waiting for the dispatched release workflow');
    requireSuccessfulRun(run);
    const artifacts = await list(`/actions/runs/${run.id}/artifacts`, 'artifacts');
    assert.deepEqual(artifacts.map(item => item.name).sort(), artifactNames, 'Release run must contain exactly three platform artifacts');
    assert(artifacts.every(item => !item.expired && item.workflow_run?.id === run.id && item.workflow_run?.head_sha === SOURCE), 'Release artifacts expired or belong to another run');
    console.log(`Verified successful release workflow ${run.id} and three complete platform artifacts`);
    const temporary = mkdtempSync(join(tmpdir(), 'papertrail-v016-'));
    try {
      const downloaded = join(temporary, 'download');
      const staged = join(temporary, 'assets');
      execFileSync('gh', ['run', 'download', String(run.id), '--repo', REPOSITORY, '--pattern', 'desktop-release-*', '--dir', downloaded], {
        timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      const names = prepareAssets(downloaded, staged, TAG);
      const expected = names.map(name => {
        const content = readFileSync(join(staged, name));
        return { name, size: content.length, digest: `sha256:${digest(content)}` };
      });
      console.log(`Prepared and hashed ${expected.length} release assets from workflow ${run.id}`);
      await updateDraft({ tag: TAG, sha: SOURCE, repository: REPOSITORY, token, directory: staged, request });
      release = (await list('/releases')).find(item => item.tag_name === TAG);
      assert(release, 'Missing prepared release draft');
      console.log(`Verifying draft ${release.id} before publishing ${TAG} at ${SOURCE}`);
      release = await publishVerified({ api, runId: run.id, releaseId: release.id, expected });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  const summary = `Published unsigned preview: ${release.html_url}\n\nSource commit: ${SOURCE}\n\n${run ? `Release workflow: https://github.com/${REPOSITORY}/actions/runs/${run.id}` : 'Existing published release verified without modification.'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  const retained = `Temporary branch ${BRANCH} retained for review; main was not modified.${alreadyPublished ? ' No remote changes made.' : ''}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${retained}\n`);
  console.log(retained);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
