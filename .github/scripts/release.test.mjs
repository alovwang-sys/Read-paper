import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ensureManualTag, expectedAssets, prepareAssets, updateDraft, verifySource } from './release.mjs';

function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), 'papertrail-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fixture(t) {
  const root = temporary(t);
  const source = join(root, 'download');
  const destination = join(root, 'assets');
  const assets = expectedAssets('v0.1.0');
  for (const [target, names] of Object.entries(assets)) {
    const directory = join(source, `desktop-release-${target}`, 'nested');
    mkdirSync(directory, { recursive: true });
    for (const name of names) writeFileSync(join(directory, name), `test fixture ${name}`);
  }
  return { source, destination };
}

test('only exact version tags whose source is on main can be released', t => {
  const cwd = temporary(t);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'Release test');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  git('add', 'package.json');
  git('commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  git('tag', 'v0.1.0');
  git('tag', 'v0.2.0');
  const input = { tag: 'v0.1.0', event: 'push', ref: 'refs/tags/v0.1.0', eventSha: sha, cwd };
  assert.equal(verifySource(input).sha, sha);
  assert.throws(() => verifySource({ ...input, tag: 'v0.2.0', ref: 'refs/tags/v0.2.0' }), /exactly match/);
  assert.throws(() => verifySource({ ...input, tag: 'v0.1.0;echo unsafe' }), /version tag/);
  assert.throws(() => verifySource({ ...input, event: 'workflow_dispatch', ref: 'refs/heads/feature' }), /from main/);
  git('switch', '-c', 'unmerged');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  git('commit', '-am', 'not on main');
  git('tag', 'v0.2.0-rc.1');
  const unmerged = git('rev-parse', 'HEAD');
  assert.throws(() => verifySource({ ...input, tag: 'v0.2.0-rc.1', ref: 'refs/tags/v0.2.0-rc.1', eventSha: unmerged }));
  assert.throws(() => verifySource({ ...input, eventSha: unmerged }), /Tag moved/);
});

test('three complete platform artifacts preserve names and produce checksums', t => {
  const { source, destination } = fixture(t);
  const files = prepareAssets(source, destination, 'v0.1.0');
  assert.equal(files.length, 8);
  assert.equal(readdirSync(destination).length, 8);
  const checksums = readFileSync(join(destination, 'SHA256SUMS'), 'utf8');
  assert.equal(checksums.trim().split('\n').length, 7);
  assert.match(checksums, /^[a-f0-9]{64}  Papertrail-0\.1\.0-windows-x64-setup\.exe$/m);
  assert.equal(readFileSync(join(destination, 'RELEASES'), 'utf8'), 'test fixture RELEASES');
});

test('manual release creates only a matching version at its fixed main source', async t => {
  const cwd = temporary(t);
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'user.name', 'Release test');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  git('add', 'package.json');
  git('commit', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', sha);
  const input = { tag: 'v0.1.0', ref: 'refs/heads/main', sha, repository: 'owner/repo', token: 'test', cwd };
  const writes = [];
  const request = async (url, options) => {
    if (options.method !== 'POST') return new Response(null, { status: 404 });
    writes.push({ url, body: JSON.parse(options.body) });
    return Response.json({}, { status: 201 });
  };
  await ensureManualTag({ ...input, request });
  assert.deepEqual(writes, [{ url: 'https://api.github.com/repos/owner/repo/git/refs', body: { ref: 'refs/tags/v0.1.0', sha } }]);
  writes.length = 0;
  await assert.rejects(ensureManualTag({ ...input, tag: 'v0.2.0', request }), /exactly match/);
  await assert.rejects(ensureManualTag({ ...input, sha: 'a'.repeat(40), request }), /Checkout must match/);
  await assert.rejects(ensureManualTag({ ...input, ref: 'refs/heads/feature', request }), /from main/);
  await assert.rejects(ensureManualTag({ ...input, tag: 'v0.1.0;unsafe', request }), /version tag/);
  const methods = [];
  await assert.rejects(ensureManualTag({ ...input, request: async (_url, options) => {
    methods.push(options.method || 'GET');
    return new Response(null, { status: options.method === 'POST' ? 422 : 404 });
  } }), /existing tags are never overwritten/);
  assert.deepEqual(methods, ['GET', 'POST']);
  git('switch', '-c', 'unmerged');
  writeFileSync(join(cwd, 'change.txt'), 'unmerged');
  git('add', 'change.txt');
  git('commit', '-m', 'not on main');
  await assert.rejects(ensureManualTag({ ...input, sha: git('rev-parse', 'HEAD'), request }));
  assert.equal(writes.length, 0);
});

test('existing tags and permission failures cause no tag writes', async () => {
  const input = { tag: 'v0.1.0', ref: 'refs/heads/main', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test' };
  let writes = 0;
  await ensureManualTag({ ...input, cwd: '/not-a-checkout', request: async (_url, options) => {
    if (options.method) writes++;
    return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  } });
  await assert.rejects(ensureManualTag({ ...input, request: async (_url, options) => {
    if (options.method) writes++;
    return new Response(null, { status: 403 });
  } }), /Reading version tag failed/);
  assert.equal(writes, 0);
});

test('missing platforms, duplicate names and unexpected files stop release preparation', t => {
  const missing = fixture(t);
  rmSync(join(missing.source, 'desktop-release-macos-x64'), { recursive: true });
  assert.throws(() => prepareAssets(missing.source, missing.destination, 'v0.1.0'), /three platform artifacts/);
  const duplicate = fixture(t);
  writeFileSync(join(duplicate.source, 'desktop-release-macos-x64', 'nested', 'Papertrail-0.1.0-arm64.dmg'), 'collision');
  assert.throws(() => prepareAssets(duplicate.source, duplicate.destination, 'v0.1.0'), /Unexpected or missing/);
  const unsafe = fixture(t);
  writeFileSync(join(unsafe.source, 'desktop-release-windows-x64', 'nested', '.env.local'), 'must not upload');
  assert.throws(() => prepareAssets(unsafe.source, unsafe.destination, 'v0.1.0'), /Unexpected or missing/);
});

test('wrong-version archives and unexpected executable files are rejected', t => {
  const wrong = fixture(t);
  writeFileSync(join(wrong.source, 'desktop-release-windows-x64', 'nested', 'debug.exe'), 'unexpected');
  assert.throws(() => prepareAssets(wrong.source, wrong.destination, 'v0.1.0'), /exact version/);
  const otherVersion = fixture(t);
  assert.throws(() => prepareAssets(otherVersion.source, otherVersion.destination, 'v0.2.0'), /exact version/);
  assert(expectedAssets('v0.2.0-beta.1')['windows-x64'].includes('Papertrail-0.2.0-beta1-full.nupkg'));
});

test('an already published release is never mutated', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  const calls = [];
  const request = async (url, options) => {
    calls.push([url, options.method]);
    if (url.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    return Response.json([{ id: 1, tag_name: 'v0.1.0', draft: false }]);
  };
  await assert.rejects(updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request }), /already published/);
  assert.equal(calls.length, 2);
  assert(calls.every(([, method]) => method === 'GET'));
});

test('a detached draft for the requested version blocks duplicate creation', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  const detached = { id: 7, tag_name: 'untagged-9e1df116753ed65036b0', name: 'Papertrail v0.1.0 — unsigned preview', draft: true, body: `Source commit: ${'a'.repeat(40)}`, assets: [] };
  const writes = [];
  const request = async (url, options) => {
    if (options.method !== 'GET') writes.push(options.method);
    if (url.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    return Response.json(url.includes('per_page=') ? [detached] : detached);
  };
  await assert.rejects(updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request }), /lost its version tag/);
  assert.deepEqual(writes, []);
});

test('a single draft preserves its tag through metadata updates and is never automatically published', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  let release;
  const calls = [];
  const request = async (url, options) => {
    calls.push([url, options]);
    const parsed = new URL(url);
    if (url.includes('/git/ref/')) return Response.json({ object: { type: 'tag', sha: 'b'.repeat(40) } });
    if (url.includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    if (parsed.pathname.endsWith('/releases') && options.method === 'GET') return Response.json([]);
    if (parsed.pathname.endsWith('/releases') && options.method === 'POST') {
      release = { ...JSON.parse(options.body), id: 7, assets: [], html_url: 'https://github.com/owner/repo/releases/tag/v0.1.0' };
    } else if (parsed.hostname === 'uploads.github.com') {
      release.assets.push({ id: release.assets.length + 1, name: parsed.searchParams.get('name'), digest: `sha256:${createHash('sha256').update(options.body).digest('hex')}`, size: options.body.length });
    } else if (options.method === 'PATCH') {
      const change = JSON.parse(options.body);
      assert(!Object.hasOwn(change, 'draft'));
      Object.assign(release, change);
      // GitHub removes the draft's tag when PATCH omits tag_name (gh release edit preserves it).
      if (!Object.hasOwn(change, 'tag_name')) release.tag_name = 'untagged-9e1df116753ed65036b0';
    }
    return Response.json(release);
  };
  const url = await updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request });
  assert.equal(release.draft, true);
  assert.equal(release.prerelease, true);
  assert.equal(release.tag_name, 'v0.1.0');
  assert.equal(release.assets.length, 8);
  assert.match(release.body, /Unsigned preview/);
  assert.match(url, /\/releases\/tag\/v0.1.0$/);
  assert.equal(calls.filter(([address, options]) => address.endsWith('/releases') && options.method === 'POST').length, 1);
});

test('manual publication while the job is running stops further writes', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  const published = { id: 7, tag_name: 'v0.1.0', draft: false, assets: [] };
  const calls = [];
  const request = async (url, options) => {
    calls.push(options.method);
    if (url.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    return Response.json(url.includes('per_page=') ? [{ ...published, draft: true, body: `Source commit: ${'a'.repeat(40)}` }] : published);
  };
  await assert.rejects(updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request }), /already published/);
  assert(calls.every(method => method === 'GET'));
});

test('tag movement, a draft from another commit and stale assets cause no writes', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  const input = { tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination };
  const writes = [];
  const request = release => async (url, options) => {
    if (options.method !== 'GET') writes.push(url);
    if (url.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
    return Response.json([release]);
  };
  await assert.rejects(updateDraft({ ...input, request: async (_url, options) => {
    if (options.method !== 'GET') writes.push('unexpected mutation');
    return Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } });
  } }), /tag moved/);
  await assert.rejects(updateDraft({ ...input, request: request({ draft: true, tag_name: input.tag, body: `Source commit: ${'b'.repeat(40)}`, assets: [] }) }), /different or unknown/);
  await assert.rejects(updateDraft({ ...input, request: request({ draft: true, tag_name: input.tag, body: `Source commit: ${input.sha}`, assets: [{ name: 'old-debug.zip' }] }) }), /unexpected assets/);
  assert.equal(writes.length, 0);
});

test('staged checksums must still match the exact prepared files', async t => {
  const { source, destination } = fixture(t);
  prepareAssets(source, destination, 'v0.1.0');
  writeFileSync(join(destination, 'Papertrail-0.1.0-macos-arm64.dmg'), 'modified after preparation');
  await assert.rejects(updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request: () => assert.fail('must not access GitHub') }), /SHA256SUMS/);
});

test('uploaded digests and the final asset set must match local staging', async t => {
  for (const mismatch of ['digest', 'missing']) await t.test(mismatch, async child => {
    const { source, destination } = fixture(child);
    const files = prepareAssets(source, destination, 'v0.1.0');
    const release = { id: 7, draft: true, tag_name: 'v0.1.0', body: `Source commit: ${'a'.repeat(40)}`, assets: [] };
    const request = async (url, options) => {
      if (url.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: 'a'.repeat(40) } });
      if (url.includes('per_page=')) return Response.json([release]);
      if (url.startsWith('https://uploads.github.com/')) release.assets.push({ name: new URL(url).searchParams.get('name'), size: options.body.length, digest: `sha256:${createHash('sha256').update(options.body).digest('hex')}` });
      if (options.method === 'GET' && release.assets.length === files.length) {
        const response = structuredClone(release);
        if (mismatch === 'digest') response.assets[0].digest = `sha256:${'0'.repeat(64)}`;
        else response.assets.pop();
        return Response.json(response);
      }
      return Response.json(release);
    };
    await assert.rejects(updateDraft({ tag: 'v0.1.0', sha: 'a'.repeat(40), repository: 'owner/repo', token: 'test', directory: destination, request }), mismatch === 'digest' ? /Uploaded SHA-256/ : /asset set differs/);
    assert.equal(release.draft, true);
  });
});
