import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = ['macos-arm64', 'macos-x64', 'windows-x64'];
const versionPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-zA-Z]+(?:[.-][\da-zA-Z]+)*)?$/;
const digest = content => createHash('sha256').update(content).digest('hex');

export function expectedAssets(tag) {
  assert(versionPattern.test(tag), 'Use a version tag such as v0.1.0 or v0.1.0-beta.1');
  const version = tag.slice(1);
  // Squirrel's convertVersion strips dots from the prerelease identifier.
  const [main, ...prerelease] = version.split('-');
  const nugetVersion = prerelease.length ? `${main}-${prerelease.join('-').replaceAll('.', '')}` : main;
  return {
    'macos-arm64': [`Papertrail-${version}-macos-arm64.dmg`, `Papertrail-darwin-arm64-${version}.zip`],
    'macos-x64': [`Papertrail-${version}-macos-x64.dmg`, `Papertrail-darwin-x64-${version}.zip`],
    'windows-x64': [`Papertrail-${version}-windows-x64-setup.exe`, `Papertrail-${nugetVersion}-full.nupkg`, 'RELEASES'],
  };
}

function stagedAssets(directory, tag) {
  const expected = [...Object.values(expectedAssets(tag)).flat(), 'SHA256SUMS'].sort();
  assert.deepEqual(readdirSync(directory).sort(), expected, 'Staged assets must exactly match the version, platform and architecture');
  const assets = expected.map(name => {
    const content = readFileSync(join(directory, name));
    assert(content.length > 0, `Empty release asset: ${name}`);
    return { name, hash: digest(content), size: content.length };
  });
  const checksums = assets.filter(asset => asset.name !== 'SHA256SUMS').map(asset => `${asset.hash}  ${asset.name}`).sort().join('\n') + '\n';
  assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'), checksums, 'Staged assets do not match SHA256SUMS');
  return assets;
}

export function verifySource({ tag, event, ref, eventSha, cwd = process.cwd() }) {
  assert(versionPattern.test(tag), 'Use a version tag such as v0.1.0 or v0.1.0-beta.1');
  assert(event === 'push' || event === 'workflow_dispatch', 'Unsupported release event');
  if (event === 'workflow_dispatch') assert.equal(ref, 'refs/heads/main', 'Run the manual workflow from main');
  else assert.equal(ref, `refs/tags/${tag}`, 'The push must refer to the requested version tag');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const sha = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
  git('merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main');
  if (event === 'push') assert.equal(git('rev-parse', '--verify', `${eventSha}^{commit}`), sha, 'Tag moved after this run started');
  const version = JSON.parse(git('show', `${sha}:package.json`)).version;
  assert.equal(tag, `v${version}`, 'Tag must exactly match package.json version');
  return { tag, sha, version };
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${entry.name}`);
    if (entry.isDirectory()) return walkFiles(path);
    assert(entry.isFile(), `Unexpected file type: ${entry.name}`);
    return [path];
  });
}

export function prepareAssets(source, destination, tag) {
  const expectedNames = expectedAssets(tag);
  const expected = targets.map(target => `desktop-release-${target}`);
  assert.deepEqual(readdirSync(source).sort(), [...expected].sort(), 'All three platform artifacts are required');
  const files = expected.flatMap((directory, index) => {
    const entries = walkFiles(join(source, directory));
    assert.deepEqual(entries.map(file => basename(file)).sort(), [...expectedNames[targets[index]]].sort(), `Unexpected or missing installer for ${targets[index]}; require exact version and architecture names`);
    return entries;
  });
  const names = files.map(file => basename(file));
  assert.equal(new Set(names).size, names.length, 'Installer names must include platform/architecture to avoid collisions');
  mkdirSync(destination, { recursive: true });
  assert.equal(readdirSync(destination).length, 0, 'Release staging directory must be empty');
  const sums = files.map(file => {
    const name = basename(file);
    const content = readFileSync(file);
    assert(content.length > 0, `Empty release asset: ${name}`);
    copyFileSync(file, join(destination, name));
    return `${digest(content)}  ${name}`;
  });
  writeFileSync(join(destination, 'SHA256SUMS'), `${sums.sort().join('\n')}\n`);
  return [...names, 'SHA256SUMS'];
}

export function releaseNotes(tag, sha) {
  return `Papertrail ${tag}\n\n` +
    `Source commit: ${sha}\n\n` +
    '**Unsigned preview — manual installation acceptance required.**\n\n' +
    '- macOS Apple silicon: arm64 DMG; Intel: x64 DMG.\n' +
    '- Windows: x64 Setup.exe. Keep the accompanying .nupkg and RELEASES files together if using Squirrel metadata.\n' +
    '- macOS Developer ID signing / Apple notarization and Windows publisher signing are not configured. System security prompts may appear.\n' +
    '- SHA256SUMS verifies download integrity; it does not replace publisher signing.\n' +
    '- CI launches the packaged application. Installer UI, OS trust prompts, clean-machine installation and upgrade data preservation still require manual checks.\n' +
    '- Local data does not sync between computers. Browser data is not automatically migrated into the desktop profile.\n' +
    '- Move data manually using Settings → Workspace backup and restore. The full ZIP includes source PDFs and region images, excludes API keys, and is limited to 256 MiB total / 64 MiB per asset. Markdown export is not a full backup.\n' +
    '- Automatic application updates are not enabled. AI requires the user’s own model configuration; no provider credentials are included.\n\n' +
    'Keep this release as a draft until all three installers have passed the acceptance checklist in docs/desktop-distribution.md. ' +
    'Do not publish this draft while the workflow is running.\n';
}

export async function updateDraft({ tag, sha, repository, token, directory, request = fetch }) {
  assert(versionPattern.test(tag), 'Invalid release tag');
  assert(/^[a-f0-9]{40}$/.test(sha), 'Invalid source commit');
  assert(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid repository');
  assert(token, 'Missing release token');
  const staged = stagedAssets(directory, tag);
  const files = staged.map(asset => asset.name);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const base = `https://api.github.com/repos/${repository}`;
  const api = async (path, { method = 'GET', body } = {}) => {
    const response = await request(`${base}${path}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `GitHub API ${method} ${path} failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  const requireSourceTag = async () => {
    let { object } = await api(`/git/ref/tags/${encodeURIComponent(tag)}`);
    for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
      assert(/^[a-f0-9]{40}$/.test(object.sha), 'Invalid annotated tag object');
      ({ object } = await api(`/git/tags/${object.sha}`));
    }
    assert(object?.type === 'commit' && object.sha === sha, 'Remote version tag moved during the build; refusing to modify a release');
  };
  await requireSourceTag();
  let release;
  for (let page = 1; ; page++) {
    const releases = await api(`/releases?per_page=100&page=${page}`);
    release = releases.find(item => item.tag_name === tag);
    if (release || releases.length < 100) break;
  }
  const requireExpectedDraft = current => {
    assert(current.draft, `Release ${tag} is already published; it will not be modified`);
    assert.equal(current.tag_name, tag, 'Release is no longer the expected draft');
    assert.equal(current.body?.match(/^Source commit: ([a-f0-9]{40})$/m)?.[1], sha, 'Existing draft belongs to a different or unknown source commit; refusing to overwrite it');
    assert(Array.isArray(current.assets) && current.assets.every(asset => files.includes(asset.name)), 'Draft contains unexpected assets; refusing to leave stale files in a release');
  };
  if (release) requireExpectedDraft(release);
  const body = releaseNotes(tag, sha);
  const metadata = { name: `Papertrail ${tag} — unsigned preview`, body, prerelease: true };
  if (!release) release = await api('/releases', {
    method: 'POST', body: { ...metadata, tag_name: tag, target_commitish: sha, draft: true },
  });
  const requireDraft = async () => {
    const current = await api(`/releases/${release.id}`);
    requireExpectedDraft(current);
    return current;
  };
  await requireDraft();
  // Never send draft:true to PATCH: a concurrent manual publish must not be reverted.
  await api(`/releases/${release.id}`, { method: 'PATCH', body: metadata });
  for (const name of files) {
    const content = readFileSync(join(directory, name));
    const current = await requireDraft();
    const existing = current.assets.find(asset => asset.name === name);
    if (existing?.digest === `sha256:${digest(content)}`) continue;
    if (existing) await api(`/releases/assets/${existing.id}`, { method: 'DELETE' });
    await requireDraft();
    const response = await request(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body: content,
    });
    assert(response.ok, `Uploading ${name} failed (${response.status})`);
  }
  const completed = await requireDraft();
  await requireSourceTag();
  assert.deepEqual(completed.assets.map(asset => asset.name).sort(), [...files].sort(), 'Draft asset set differs from the complete staged release');
  for (const asset of staged) {
    const uploaded = completed.assets.find(item => item.name === asset.name);
    assert.equal(uploaded.digest, `sha256:${asset.hash}`, `Uploaded SHA-256 differs for ${asset.name}`);
    assert.equal(uploaded.size, asset.size, `Uploaded size differs for ${asset.name}`);
  }
  return completed.html_url;
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'verify') {
    const source = verifySource({ tag: process.env.RELEASE_TAG, event: process.env.RELEASE_EVENT, ref: process.env.RELEASE_REF, eventSha: process.env.RELEASE_EVENT_SHA });
    assert(process.env.GITHUB_OUTPUT, 'Missing Actions output file');
    appendFileSync(process.env.GITHUB_OUTPUT, `tag=${source.tag}\nsha=${source.sha}\n`);
    console.log(`Verified ${source.tag} at ${source.sha} on main`);
  } else if (mode === 'prepare') {
    assert(process.env.ASSET_ROOT && process.env.ASSET_DEST, 'Missing asset directories');
    console.log(`Prepared ${prepareAssets(process.env.ASSET_ROOT, process.env.ASSET_DEST, process.env.RELEASE_TAG).length} release assets`);
  } else if (mode === 'draft') {
    const url = await updateDraft({ tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA, repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN, directory: process.env.ASSET_DEST });
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Unsigned preview draft: ${url}\n\nManual installer acceptance and publication are still required.\n`);
    console.log(`Draft ready: ${url}`);
  } else throw new Error('Expected verify, prepare or draft');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
