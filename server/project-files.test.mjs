import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, stat, rename, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { writeProjectFiles } from './project-files.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (path, content, encoding = 'utf8') => ({ path, content, encoding, hash: hash(Buffer.from(content, encoding)) });
const payload = (...extra) => ({ files: [file('README.md', '# Research\nSee [cards](cards/card-a.md).'), file('research.json', '{"format":"papertrail-research","version":1}'), ...extra] });
const stringify = value => JSON.stringify(value, null, 2) + '\n';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-files-test-')));
  const project = { path: root, projectId: 'project-a', researchId: 'research-a' };
  const output = join(root, 'Papertrail');
  t.after(async () => { await chmod(output, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  return { root, output, project, sync: value => writeProjectFiles(project, value) };
}
const contents = path => readFile(path, 'utf8');
const manifest = f => contents(join(f.output, '.papertrail-manifest.json')).then(JSON.parse);

async function interrupted(f, nextPayload, { committed = false, externalEdit = false } = {}) {
  const previous = await manifest(f);
  const next = { ...previous, updatedAt: '2026-10-17T12:00:00.000Z', files: Object.fromEntries(nextPayload.files.map(item => [item.path, { hash: item.hash, size: Buffer.from(item.content, item.encoding).length, encoding: item.encoding }])) };
  const operations = [...new Set([...Object.keys(previous.files), ...Object.keys(next.files)])].sort().flatMap(path => {
    const oldHash = previous.files[path]?.hash, nextHash = next.files[path]?.hash;
    return oldHash === nextHash ? [] : [{ path, ...(oldHash ? { oldHash } : {}), ...(nextHash ? { nextHash } : {}) }];
  });
  const staging = join(f.output, '.papertrail-transaction');
  await mkdir(staging);
  const transaction = { version: 1, projectId: f.project.projectId, pid: process.pid, previous, next, operations };
  await writeFile(join(staging, 'journal.json'), stringify(transaction));
  for (const [index, operation] of operations.entries()) {
    if (operation.oldHash) await rename(join(f.output, operation.path), join(staging, `${index}.old`));
    if (operation.nextHash) {
      const nextFile = nextPayload.files.find(item => item.path === operation.path);
      await mkdir(join(f.output, operation.path.split('/').slice(0, -1).join('/')), { recursive: true });
      await writeFile(join(f.output, operation.path), Buffer.from(nextFile.content, nextFile.encoding));
    }
  }
  if (externalEdit) await writeFile(join(f.output, operations[0].path), 'Edited outside after interruption');
  if (committed) await writeFile(join(f.output, '.papertrail-manifest.json'), stringify(next));
  return { previous, next, staging };
}

test('writes visible research, source bytes and Markdown without touching root user files or native logs', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'AGENTS.md'), 'User instructions');
  await mkdir(join(f.root, '.codex'));
  await writeFile(join(f.root, '.codex', 'session.jsonl'), 'native session');
  const pdf = Buffer.from('%PDF-1.7\nactual PDF bytes\n');
  const result = await f.sync(payload(file('library/document-a.pdf', pdf.toString('base64'), 'base64'), file('library/document-a.md', '# Metadata'), file('cards/card-a.md', '# Viewpoint'), file('excerpts/evidence-a.md', 'p. 1 quote'), file('drafts/draft-a.md', '# Conclusion'), file('boards/board-a.json', '{"placements":[]}'), file('sessions/index.md', 'Native session archive'), file('sessions/conversation-a.md', 'nativeSessionId: native-a\nReadable archive only.')));
  assert.equal(result.files, 10);
  assert.equal(result.written, 10);
  assert.deepEqual(await readFile(join(f.output, 'library/document-a.pdf')), pdf);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), '# Viewpoint');
  assert.equal(await contents(join(f.root, 'AGENTS.md')), 'User instructions');
  assert.equal(await contents(join(f.root, '.codex/session.jsonl')), 'native session');
  assert.equal((await manifest(f)).projectId, 'project-a');
  assert.equal((await manifest(f)).files['library/document-a.pdf'].hash, hash(pdf));
});

test('idempotent saves and text-only changes keep the same PDF inode and mtime', async t => {
  const f = await fixture(t), pdf = file('library/doc.pdf', Buffer.from('%PDF same source').toString('base64'), 'base64');
  const initial = await f.sync(payload(pdf, file('cards/card-a.md', 'Before')));
  const before = await stat(join(f.output, pdf.path));
  const unchanged = await f.sync(payload(pdf, file('cards/card-a.md', 'Before')));
  assert.equal(unchanged.written, 0); assert.equal(unchanged.updatedAt, initial.updatedAt);
  const changed = await f.sync(payload(pdf, file('cards/card-a.md', 'After')));
  assert.equal(changed.written, 1); assert.equal(changed.skipped, 3);
  const after = await stat(join(f.output, pdf.path));
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'After');
});

test('valid multi-megabyte PDF assets save without overflowing the base64 validator', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(8 * 1024 * 1024, 65);
  bytes.write('%PDF-1.7\n');
  const pdf = file('library/large.pdf', bytes.toString('base64'), 'base64');
  const result = await f.sync(payload(pdf));
  assert.equal(result.written, 3);
  assert.deepEqual(await readFile(join(f.output, pdf.path)), bytes);
  assert.equal((await manifest(f)).files[pdf.path].hash, hash(bytes));
});

test('removes only unchanged managed exports and preserves user-added files', async t => {
  const f = await fixture(t);
  await f.sync(payload(file('cards/removed.md', 'Old generated card')));
  await writeFile(join(f.output, 'cards', 'my-notes.md'), 'User notes');
  await f.sync(payload());
  await assert.rejects(readFile(join(f.output, 'cards/removed.md')), { code: 'ENOENT' });
  assert.equal(await contents(join(f.output, 'cards/my-notes.md')), 'User notes');
  assert.deepEqual(Object.keys((await manifest(f)).files), ['README.md', 'research.json']);
});

test('modified exported text blocks the whole save and keeps the last manifest and bytes', async t => {
  const f = await fixture(t);
  await f.sync(payload(file('cards/card-a.md', 'Generated')));
  const before = await contents(join(f.output, '.papertrail-manifest.json'));
  await writeFile(join(f.output, 'cards/card-a.md'), 'External edit');
  await assert.rejects(f.sync(payload(file('cards/card-a.md', 'New app content'))), { code: 'project_files_conflict' });
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'External edit');
  assert.equal(await contents(join(f.output, '.papertrail-manifest.json')), before);
  assert.equal((await readdir(f.output)).includes('.papertrail-transaction'), false);
});

test('externally deleted exports and changed exports scheduled for deletion are conflicts', async t => {
  const f = await fixture(t);
  await f.sync(payload(file('cards/card-a.md', 'Generated')));
  await writeFile(join(f.output, 'cards/card-a.md'), 'Do not delete');
  await assert.rejects(f.sync(payload()), { code: 'project_files_conflict' });
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Do not delete');
  await rm(join(f.output, 'cards/card-a.md'));
  await assert.rejects(f.sync(payload()), { code: 'project_files_conflict' });
});

test('new generated filenames cannot replace an untracked user file', async t => {
  const f = await fixture(t);
  await f.sync(payload()); await mkdir(join(f.output, 'cards'));
  await writeFile(join(f.output, 'cards/card-a.md'), 'User file');
  await assert.rejects(f.sync(payload(file('cards/card-a.md', 'Generated'))), { code: 'project_files_conflict' });
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'User file');
});

test('pre-existing unmanaged Papertrail directory is never adopted, even when empty', async t => {
  const f = await fixture(t); await mkdir(f.output);
  await assert.rejects(f.sync(payload()), { code: 'project_files_unmanaged' });
  assert.deepEqual(await readdir(f.output), []);
  await writeFile(join(f.output, 'README.md'), 'User documentation');
  await assert.rejects(f.sync(payload()), { code: 'project_files_unmanaged' });
  assert.equal(await contents(join(f.output, 'README.md')), 'User documentation');
});

test('another project or research cannot use an existing managed directory', async t => {
  const f = await fixture(t); await f.sync(payload());
  await assert.rejects(writeProjectFiles({ ...f.project, projectId: 'project-b' }, payload()), { code: 'project_files_identity_mismatch' });
  await assert.rejects(writeProjectFiles({ ...f.project, researchId: 'research-b' }, payload()), { code: 'project_files_identity_mismatch' });
  assert.equal((await manifest(f)).researchId, 'research-a');
});

test('traversal, absolute, hidden, nested and executable paths are rejected before any output', async t => {
  const f = await fixture(t);
  for (const path of ['../AGENTS.md', '/tmp/evil.md', 'cards/../AGENTS.md', 'cards\\evil.md', '.codex/config.json', 'cards/nested/evil.md', 'cards/a.js', 'cards/.secret.md', 'cards/a..b.md', 'README.md/elsewhere.md']) {
    await assert.rejects(f.sync(payload(file(path, 'unsafe'))), { code: 'invalid_project_files' }, path);
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('drawing scenes the app exports save under drawings/ as base64 and nowhere else', async t => {
  const f = await fixture(t);
  const scene = Buffer.from('{"type":"excalidraw","version":2,"elements":[]}');
  await f.sync(payload(file('drawings/drawing-a.excalidraw', scene.toString('base64'), 'base64')));
  assert.deepEqual(await readFile(join(f.output, 'drawings/drawing-a.excalidraw')), scene);
  for (const path of ['images/a.excalidraw', 'drawings/a.md', 'drawings/a.png']) await assert.rejects(f.sync(payload(file(path, scene.toString('base64'), 'base64'))), { code: 'invalid_project_files' }, path);
});

test('missing required entry files, duplicate paths, invalid hashes and wrong encodings do not touch the directory', async t => {
  const f = await fixture(t);
  const base = payload();
  for (const value of [{ files: [] }, { files: [base.files[0]] }, { files: [...base.files, base.files[0]] }, { files: [...base.files, { ...file('cards/a.md', 'text'), hash: '0'.repeat(64) }] }, { files: [...base.files, { ...file('cards/a.md', 'text'), hash: 'A'.repeat(64) }] }, { files: [...base.files, file('library/a.pdf', 'not base64')] }, { files: [...base.files, { path: 'library/a.pdf', content: '@@==', hash: '0'.repeat(64), encoding: 'base64' }] }]) {
    await assert.rejects(f.sync(value), error => error.status === 400);
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('noncanonical base64 is rejected instead of silently decoding a different value', async t => {
  const f = await fixture(t);
  const value = { path: 'images/a.png', content: 'Zh==', encoding: 'base64', hash: hash(Buffer.from('f')) };
  await assert.rejects(f.sync(payload(value)), { code: 'project_files_hash_mismatch' });
  assert.deepEqual(await readdir(f.root), []);
});

test('malformed base64 padding, whitespace and URL-safe characters are rejected before writing', async t => {
  const f = await fixture(t);
  for (const content of ['YQ==YQ==', 'YQ=', 'Y Q==', 'YQ==\n', '-_==', 'YQ======']) {
    await assert.rejects(f.sync(payload({ path: 'images/a.png', content, encoding: 'base64', hash: hash(Buffer.from(content, 'base64')) })), { code: 'invalid_project_files' });
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('text and asset size limits reject oversized content before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.sync(payload(file('cards/large.md', 'x'.repeat(8 * 1024 * 1024 + 1)))), { code: 'project_files_too_large' });
  const oversized = { path: 'library/large.pdf', content: 'A'.repeat(Math.ceil(64 * 1024 * 1024 / 3) * 4 + 4), encoding: 'base64', hash: '0'.repeat(64) };
  await assert.rejects(f.sync(payload(oversized)), { code: 'project_files_too_large' });
  assert.deepEqual(await readdir(f.root), []);
});

test('UTF-8 byte size, not string length, enforces the text limit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.sync(payload(file('cards/large.md', '汉'.repeat(3 * 1024 * 1024)))), { code: 'project_files_too_large' });
  assert.deepEqual(await readdir(f.root), []);
});

test('total decoded size is limited to 256 MiB', async t => {
  const f = await fixture(t), content = 'x'.repeat(1024 * 1024), digest = hash(content);
  const extra = Array.from({ length: 256 }, (_, index) => ({ path: `cards/card-${index}.md`, content, encoding: 'utf8', hash: digest }));
  await assert.rejects(f.sync(payload(...extra)), { code: 'project_files_too_large' });
  assert.deepEqual(await readdir(f.root), []);
});

test('root and output symlinks are rejected without reading or changing their targets', async t => {
  const f = await fixture(t); const outside = join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, f.output);
  await assert.rejects(f.sync(payload()), { code: 'invalid_project_files_directory' });
  assert.deepEqual(await readdir(outside), []);
  await rm(f.output); const alias = join(f.root, 'alias'); await symlink(outside, alias);
  await assert.rejects(writeProjectFiles({ ...f.project, path: alias }, payload()), { code: 'invalid_project_files_directory' });
  assert.deepEqual(await readdir(outside), []);
});

test('nested directory and individual export symlinks cannot escape managed output', async t => {
  const f = await fixture(t); await f.sync(payload());
  const outside = join(f.root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'card-a.md'), 'Outside');
  await symlink(outside, join(f.output, 'cards'));
  await assert.rejects(f.sync(payload(file('cards/card-a.md', 'Generated'))), { code: 'invalid_project_files_directory' });
  assert.equal(await contents(join(outside, 'card-a.md')), 'Outside');
  await rm(join(f.output, 'cards')); await mkdir(join(f.output, 'cards'));
  await symlink(join(outside, 'card-a.md'), join(f.output, 'cards/card-a.md'));
  await assert.rejects(f.sync(payload(file('cards/card-a.md', 'Generated'))), { code: 'project_files_conflict' });
  assert.equal(await contents(join(outside, 'card-a.md')), 'Outside');
});

test('metadata symlinks, mismatched manifests and malformed metadata are preserved', async t => {
  const f = await fixture(t); await f.sync(payload());
  const original = await contents(join(f.output, '.papertrail-manifest.json'));
  await writeFile(join(f.output, '.papertrail-manifest.json'), JSON.stringify({ ...(JSON.parse(original)), projectId: 'other-project' }));
  await assert.rejects(f.sync(payload()), { code: 'invalid_project_files_metadata' });
  await writeFile(join(f.output, '.papertrail-manifest.json'), '{ malformed');
  await assert.rejects(f.sync(payload()), { code: 'invalid_project_files_metadata' });
  assert.equal(await contents(join(f.output, '.papertrail-manifest.json')), '{ malformed');
  await rm(join(f.output, '.papertrail-manifest.json'));
  const external = join(f.root, 'external.json'); await writeFile(external, original);
  await symlink(external, join(f.output, '.papertrail-manifest.json'));
  await assert.rejects(f.sync(payload()), { code: 'project_files_conflict' });
  assert.equal(await contents(external), original);
});

test('read-only exported files are not replaced or removed', async t => {
  const f = await fixture(t); await f.sync(payload(file('cards/card-a.md', 'Before')));
  const path = join(f.output, 'cards/card-a.md'); await chmod(path, 0o444);
  await assert.rejects(f.sync(payload(file('cards/card-a.md', 'After'))), { code: 'project_files_readonly' });
  await assert.rejects(f.sync(payload()), { code: 'project_files_readonly' });
  assert.equal(await contents(path), 'Before');
  await chmod(path, 0o600);
});

test('unwritable output fails before replacing the last successful file set', async t => {
  if (process.getuid?.() === 0) { t.skip('root bypasses filesystem write permissions'); return; }
  const f = await fixture(t); await f.sync(payload(file('cards/card-a.md', 'Before')));
  const before = await contents(join(f.output, '.papertrail-manifest.json'));
  await chmod(f.output, 0o500);
  try { await assert.rejects(f.sync(payload(file('cards/card-a.md', 'After'))), error => ['EACCES', 'EPERM'].includes(error.code)); }
  finally { await chmod(f.output, 0o700); }
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Before');
  assert.equal(await contents(join(f.output, '.papertrail-manifest.json')), before);
});

test('interrupted uncommitted replacement is rolled back before a subsequent save', async t => {
  const f = await fixture(t); const initial = payload(file('cards/card-a.md', 'Original'));
  await f.sync(initial);
  await interrupted(f, payload(file('cards/card-a.md', 'Interrupted content'), file('sessions/new.md', 'New archive')));
  await f.sync(initial);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Original');
  await assert.rejects(readFile(join(f.output, 'sessions/new.md')), { code: 'ENOENT' });
  assert.equal((await readdir(f.output)).includes('.papertrail-transaction'), false);
});

test('post-commit cleanup recovery keeps the committed bytes rather than restoring old ones', async t => {
  const f = await fixture(t); await f.sync(payload(file('cards/card-a.md', 'Original')));
  const next = payload(file('cards/card-a.md', 'Committed'));
  await interrupted(f, next, { committed: true });
  const result = await f.sync(next);
  assert.equal(result.written, 0);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Committed');
  assert.equal((await readdir(f.output)).includes('.papertrail-transaction'), false);
});

test('recovery preserves an external edit and the backup instead of overwriting either', async t => {
  const f = await fixture(t); await f.sync(payload(file('cards/card-a.md', 'Original')));
  const result = await interrupted(f, payload(file('cards/card-a.md', 'Interrupted')), { externalEdit: true });
  await assert.rejects(f.sync(payload()), { code: 'project_files_conflict' });
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Edited outside after interruption');
  assert.equal(await contents(join(result.staging, '0.old')), 'Original');
  assert.deepEqual(await manifest(f), result.previous);
});

test('serializes simultaneous saves for the same project into complete file sets', async t => {
  const f = await fixture(t);
  await Promise.all([f.sync(payload(file('cards/card-a.md', 'First'))), f.sync(payload(file('cards/card-a.md', 'Second')))]);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Second');
  assert.equal((await manifest(f)).files['cards/card-a.md'].hash, hash('Second'));
  assert.equal((await readdir(f.output)).includes('.papertrail-transaction'), false);
});

test('reuses only previously committed bytes without resending or rewriting the PDF', async t => {
  const f = await fixture(t), pdf = file('library/doc.pdf', Buffer.from('%PDF preserved').toString('base64'), 'base64');
  await f.sync(payload(pdf));
  const before = await stat(join(f.output, pdf.path));
  const reused = { path: pdf.path, hash: pdf.hash, encoding: pdf.encoding, reuse: true };
  const result = await f.sync(payload(reused, file('cards/card-a.md', 'New card')));
  assert.equal(result.written, 1); assert.equal(result.skipped, 3);
  const after = await stat(join(f.output, pdf.path));
  assert.equal(before.ino, after.ino); assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal((await manifest(f)).files[pdf.path].size, Buffer.from(pdf.content, 'base64').length);
  assert.equal(result.bytes, payload(pdf, file('cards/card-a.md', 'New card')).files.reduce((sum, item) => sum + Buffer.from(item.content, item.encoding).length, 0));
});

test('unknown reuse, reuse with changed hash, and reuse with content preserve the old set', async t => {
  const f = await fixture(t), pdf = file('library/doc.pdf', Buffer.from('%PDF preserved').toString('base64'), 'base64');
  await f.sync(payload(pdf)); const before = await contents(join(f.output, '.papertrail-manifest.json'));
  for (const value of [{ path: 'library/unknown.pdf', hash: pdf.hash, encoding: 'base64', reuse: true }, { path: pdf.path, hash: '0'.repeat(64), encoding: 'base64', reuse: true }]) {
    await assert.rejects(f.sync(payload(value)), { code: 'project_files_reuse_unavailable' });
  }
  await assert.rejects(f.sync(payload({ ...pdf, reuse: true })), { code: 'invalid_project_files' });
  assert.equal(await contents(join(f.output, '.papertrail-manifest.json')), before);
  assert.deepEqual(await readFile(join(f.output, pdf.path)), Buffer.from(pdf.content, 'base64'));
});

test('reusing a modified or missing PDF is rejected instead of trusting its claimed hash', async t => {
  const f = await fixture(t), pdf = file('library/doc.pdf', Buffer.from('%PDF preserved').toString('base64'), 'base64');
  await f.sync(payload(pdf));
  const reused = { path: pdf.path, hash: pdf.hash, encoding: 'base64', reuse: true };
  await writeFile(join(f.output, pdf.path), 'External PDF replacement');
  await assert.rejects(f.sync(payload(reused)), { code: 'project_files_conflict' });
  assert.equal(await contents(join(f.output, pdf.path)), 'External PDF replacement');
  await rm(join(f.output, pdf.path));
  await assert.rejects(f.sync(payload(reused)), { code: 'project_files_conflict' });
});

test('failure after one replacement rolls back prior changes and keeps the previous complete manifest', async t => {
  if (process.getuid?.() === 0) { t.skip('root bypasses filesystem write permissions'); return; }
  const f = await fixture(t); const initial = payload(file('cards/card-a.md', 'Original card'));
  await f.sync(initial); const previous = await contents(join(f.output, '.papertrail-manifest.json'));
  const update = payload(file('cards/card-a.md', 'New card'));
  update.files[0] = file('README.md', '# Changed README first');
  await chmod(join(f.output, 'cards'), 0o500);
  try { await assert.rejects(f.sync(update), error => ['EACCES', 'EPERM'].includes(error.code)); }
  finally { await chmod(join(f.output, 'cards'), 0o700); }
  assert.equal(await contents(join(f.output, 'README.md')), initial.files[0].content);
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Original card');
  assert.equal(await contents(join(f.output, '.papertrail-manifest.json')), previous);
  assert.equal((await readdir(f.output)).includes('.papertrail-transaction'), false);
});

test('post-commit recovery preserves user-added files inside the transaction directory', async t => {
  const f = await fixture(t); await f.sync(payload(file('cards/card-a.md', 'Original')));
  const next = payload(file('cards/card-a.md', 'Committed'));
  const { staging } = await interrupted(f, next, { committed: true });
  await writeFile(join(staging, 'my-notes.md'), 'Keep user bytes');
  await assert.rejects(f.sync(next), { code: 'project_files_conflict' });
  assert.equal(await contents(join(staging, 'my-notes.md')), 'Keep user bytes');
  assert.equal(await contents(join(f.output, 'cards/card-a.md')), 'Committed');
});
