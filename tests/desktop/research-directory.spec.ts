import { useClassicWorkbench } from './helpers';
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin' ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const navigation = (page: Page) => page.getByRole('complementary', { name: '左侧导航' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exists = (path: string) => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
// A saving transaction moves the old file aside before installing its replacement.
const readDuringSync = (path: string) => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'papertrail-directory-desktop-')));
  const userData = join(root, 'app-data'), home = join(root, 'isolated-home'), parent = join(root, 'researches');
  await Promise.all([mkdir(userData), mkdir(join(home, 'Documents'), { recursive: true }), mkdir(parent)]);
  return { root, userData, home, parent };
}
async function data(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    return new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => { resolve(request.result); db.close(); }; request.onerror = () => { reject(request.error); db.close(); };
    });
  });
}
async function launch(userData: string, home: string, modelRequests: string[]) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '', AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  // Provide the isolated profile's Documents explicitly instead of depending on
  // the runner's user profile and Windows known-folder configuration.
  await application.evaluate(({ app }, documents) => app.setPath('documents', documents), join(home, 'Documents'));
  const page = await application.firstWindow();
  page.on('request', request => { if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url()); });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(main(page)).toBeVisible(); await useClassicWorkbench(page); await saved(page);
  expect(page.url()).toBe('papertrail://app/');
  expect(await page.evaluate(() => window.papertrailDesktop!.getProjectLocation!())).toBe(join(home, 'Documents'));
  // Return to the workbench if a real save error blocks quit; never force-close it.
  await application.evaluate(({ dialog }) => {
    const calls: { title?: string; detail?: string }[] = [];
    Reflect.set(globalThis, '__researchDirectoryCloseWarnings', calls);
    dialog.showMessageBox = async (...args: unknown[]) => { const options = args.at(-1) as { title?: string; detail?: string }; calls.push({ title: options.title, detail: options.detail }); return { response: 0, checkboxChecked: false }; };
  });
  return { application, page };
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close', { timeout: 20_000 });
  void application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
}
async function stubPicker(application: ElectronApplication, parent: string, cancelFirst = false) {
  await application.evaluate(({ dialog }, input) => {
    const calls: { defaultPath?: string; properties?: string[]; title?: string }[] = [];
    Reflect.set(globalThis, '__researchDirectoryPickerCalls', calls);
    dialog.showOpenDialog = async (...args: unknown[]) => {
      const options = args.at(-1) as { defaultPath?: string; properties?: string[]; title?: string };
      calls.push({ defaultPath: options.defaultPath, properties: options.properties, title: options.title });
      const canceled = input.cancelFirst && calls.length === 1;
      return { canceled, filePaths: canceled ? [] : [input.parent] };
    };
  }, { parent, cancelFirst });
}
async function pickerCalls(application: ElectronApplication) {
  return application.evaluate(() => Reflect.get(globalThis, '__researchDirectoryPickerCalls') as { defaultPath?: string; properties?: string[]; title?: string }[]);
}
async function openNew(page: Page, title: string) {
  await page.getByRole('button', { name: '新建研究', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建研究', exact: true });
  await dialog.getByLabel('研究名称', { exact: true }).fill(title);
  await dialog.getByLabel('新研究核心问题').fill('一次选择目录，保留研究材料与会话。');
  await expect(dialog.getByRole('button', { name: '创建并关联', exact: true })).toBeEnabled();
  return dialog;
}
async function screenshot(page: Page, name: string) {
  await mkdir(test.info().outputPath('research-directory'), { recursive: true });
  await page.screenshot({ path: test.info().outputPath('research-directory', name) });
}

test('打包桌面：原生目录选择取消无残留，创建后左右沿用同一目录且重启恢复', async () => {
  const f = await fixture(); const modelRequests: string[] = []; let application: ElectronApplication | undefined;
  const title = '目录关联与会话恢复', project = join(f.parent, title);
  try {
    let session = await launch(f.userData, f.home, modelRequests); application = session.application; let page = session.page;
    await stubPicker(application, f.parent, true);
    const before = await data(page); let dialog = await openNew(page, title);
    await dialog.getByRole('button', { name: '更改', exact: true }).click();
    await expect.poll(async () => (await pickerCalls(application!)).length).toBe(1);
    await expect(dialog.getByLabel('研究名称', { exact: true })).toHaveValue(title);
    await dialog.getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog).toHaveCount(0);
    expect(Object.keys((await data(page)).researches)).toEqual(Object.keys(before.researches));
    expect(await exists(project)).toBe(false); expect(await exists(join(f.userData, 'agents', 'projects.json'))).toBe(false);

    dialog = await openNew(page, title); await dialog.getByRole('button', { name: '更改', exact: true }).click();
    await expect(dialog.locator('.create-directory-preview')).toContainText(project);
    await dialog.getByRole('button', { name: '创建并关联', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(main(page).getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible(); await saved(page);
    const current = await data(page); if (current.scope.kind !== 'research') throw new Error('Expected current research');
    const research = current.researches[current.scope.researchId];
    expect(research.directory?.path).toBe(project);
    const manifest = JSON.parse(await readFile(join(project, '.read-paper', 'project.json'), 'utf8'));
    const registry = JSON.parse(await readFile(join(f.userData, 'agents', 'projects.json'), 'utf8'));
    expect(manifest).toMatchObject({ researchId: research.id, projectId: research.directory!.projectId, title });
    expect(registry.bindings[JSON.stringify([manifest.workspaceId, research.id])]).toMatchObject(research.directory!);
    const calls = await pickerCalls(application); expect(calls).toHaveLength(2); expect(calls.every(call => call.properties?.includes('openDirectory'))).toBe(true);
    await expect(navigation(page).getByRole('button', { name: `项目设置 · ${title}`, exact: true })).toBeVisible();
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click(); await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
    await expect(panel(page).locator('.research-directory-trigger')).toHaveCount(0);
    expect(await navigation(page).getByRole('button', { name: `项目设置 · ${title}`, exact: true }).getAttribute('title')).toContain(project);
    await expect(panel(page).getByRole('button', { name: '选择研究目录', exact: true })).toHaveCount(0);
    await panel(page).getByLabel('向 AI 提问').fill('重启后继续，尚未发送的问题'); await saved(page);
    await expect.poll(() => exists(join(project, 'Papertrail', 'research.json'))).toBe(true);
    await screenshot(page, 'desktop-created-directory.png');
    await close(application); application = undefined;

    session = await launch(f.userData, f.home, modelRequests); application = session.application; page = session.page;
    await expect(page.getByRole('button', { name: '切换研究', exact: true })).toHaveAttribute('data-research-id', research.id);
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('重启后继续，尚未发送的问题');
    await expect(panel(page).locator('.research-directory-trigger')).toHaveCount(0);
    expect((await data(page)).researches[research.id].directory).toMatchObject(research.directory!);
    expect(JSON.parse(await readFile(join(project, '.read-paper', 'project.json'), 'utf8')).projectId).toBe(manifest.projectId);
    expect(modelRequests).toEqual([]);
  } finally {
    if (application) { await close(application); application = undefined; }
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('打包桌面：真实PDF与卡片写入研究目录，UI修改同步，外部编辑冲突保护并可恢复退出', async () => {
  const f = await fixture(); const modelRequests: string[] = []; let application: ElectronApplication | undefined;
  const project = join(f.parent, 'seed-research'); await mkdir(project);
  const cardFile = join(project, 'Papertrail', 'cards', 'card-a.md');
  let restoreCard: string | undefined;
  try {
    const session = await launch(f.userData, f.home, modelRequests); application = session.application; const page = session.page;
    await stubPicker(application, project);
    await navigation(page).getByRole('button', { name: '项目设置 · 检索增强，何时有效？', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '项目设置', exact: true });
    await expect(settings.getByRole('button', { name: '选择文件夹…', exact: true })).toBeEnabled();
    await settings.getByRole('button', { name: '选择文件夹…', exact: true }).click();
    await expect(settings.locator('.directory-preview')).toContainText(project);
    await settings.getByRole('button', { name: '使用这个目录', exact: true }).click(); await expect(settings).toHaveCount(0);
    expect(await pickerCalls(application)).toHaveLength(1);
    await expect.poll(() => exists(cardFile)).toBe(true);
    await expect(page.getByRole('button', { name: '目录文件已更新', exact: true })).toBeVisible();
    const originalCard = createSeed().cards['card-a'];
    expect(await readFile(cardFile, 'utf8')).toContain(originalCard.body);
    const pdf = await readFile(join(project, 'Papertrail', 'library', 'paper-a.pdf'));
    const sample = await readFile(resolve('public/samples/adaptive-retrieval.pdf'));
    expect(hash(pdf)).toBe(hash(sample));
    const metadata = JSON.parse(await readFile(join(project, 'Papertrail', 'research.json'), 'utf8'));
    expect(metadata.entities.research.id).toBe('research-a'); expect(metadata.entities.research.title).toBe('seed-research');
    expect(Object.values(metadata.entities.conversations).every(value => (value as { researchId: string }).researchId === 'research-a')).toBe(true);
    expect(Object.values(metadata.entities.boards).every(value => (value as { researchId: string }).researchId === 'research-a')).toBe(true);
    expect(metadata.entities.conversations['conversation-research-b']).toBeUndefined();
    expect(metadata.entities.boards['board-b']).toBeUndefined();
    expect(await readFile(join(project, 'Papertrail', 'sessions', 'index.md'), 'utf8')).toContain('研究对话');
    const pdfBefore = await stat(join(project, 'Papertrail', 'library', 'paper-a.pdf'));
    await panel(page).getByRole('tab', { name: '卡片', exact: true }).click();
    await panel(page).getByRole('button', { name: /相关性是检索收益的前提/ }).first().click();
    const body = panel(page).getByLabel('卡片正文', { exact: true }); const updated = originalCard.body + '\n\n桌面真实文件同步验证。';
    await body.fill(updated); await saved(page);
    await expect.poll(() => readDuringSync(cardFile)).toContain(updated);
    const pdfAfter = await stat(join(project, 'Papertrail', 'library', 'paper-a.pdf'));
    expect(pdfAfter.ino).toBe(pdfBefore.ino); expect(pdfAfter.mtimeMs).toBe(pdfBefore.mtimeMs);
    await expect(page.getByRole('button', { name: '目录文件已更新', exact: true })).toBeVisible();

    restoreCard = await readFile(cardFile, 'utf8'); const external = '# 外部编辑\n\n这是研究者从文件夹写入的内容，不能被应用覆盖。\n'; await writeFile(cardFile, external);
    const latest = updated + '\n冲突时仍保留应用内的最新理解。'; await body.fill(latest); await saved(page);
    await expect(page.getByRole('button', { name: '目录保存失败 · 重试', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('已被修改');
    expect(await readFile(cardFile, 'utf8')).toBe(external); expect((await data(page)).cards['card-a'].body).toBe(latest);
    await screenshot(page, 'desktop-external-edit-conflict.png');
    await application.evaluate(({ app }) => app.quit());
    await expect.poll(() => application!.evaluate(() => Reflect.get(globalThis, '__researchDirectoryCloseWarnings').length)).toBe(1);
    await expect.poll(() => page.evaluate(() => document.body.inert)).toBe(false);
    expect(await readFile(cardFile, 'utf8')).toBe(external);
    await expect(body).toHaveValue(latest);

    // Restore only this test's own external edit, then use the visible recovery action.
    await writeFile(cardFile, restoreCard); restoreCard = undefined;
    await page.getByRole('button', { name: '目录保存失败 · 重试', exact: true }).click();
    await expect.poll(() => readDuringSync(cardFile)).toContain(latest);
    await expect(page.getByRole('button', { name: '目录文件已更新', exact: true })).toBeVisible();
    expect(modelRequests).toEqual([]);
  } finally {
    if (restoreCard) await writeFile(cardFile, restoreCard);
    if (application) { await close(application); application = undefined; }
    await rm(f.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
