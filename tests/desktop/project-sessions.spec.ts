import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openSource } from '../e2e/knowledge-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin' ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const navigation = (page: Page) => page.getByRole('complementary', { name: '左侧导航' });
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function launch(userData: string, home: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(main(page)).toBeVisible(); await saved(page);
    return { application, page };
  } catch (error) { const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error; }
}
async function close(application: ElectronApplication) { const exited = application.waitForEvent('close'); void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited; }

// Uses the packaged protocol and real directory service. No model request or existing native history is opened.
test('打包桌面：目录取消、确认、项目列表与重启恢复，不发送模型请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-project-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home'), project = join(directory, 'research-project');
  await Promise.all([mkdir(userData), mkdir(home), mkdir(project)]);
  let application: ElectronApplication | undefined;
  const modelRequests: string[] = [], pageErrors: string[] = [];
  const watch = (page: Page) => {
    page.on('request', request => { if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url()); });
    page.on('pageerror', error => pageErrors.push(error.message));
  };
  try {
    let session = await launch(userData, home); application = session.application; let page = session.page; watch(page);
    expect(page.url()).toBe('papertrail://app/');
    expect(await page.evaluate(async () => (await fetch('/api/ai/config')).json())).toMatchObject({ configured: false });
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await panel(page).getByLabel('向 AI 提问').fill('目录绑定前保留的阅读问题');

    await navigation(page).getByRole('button', { name: '项目设置 · 检索增强，何时有效？', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '项目设置', exact: true });
    await dialog.getByLabel('本机目录路径').fill(project); await dialog.getByRole('button', { name: '打开路径', exact: true }).click();
    await expect(dialog.locator('.directory-preview')).toContainText(await realpath(project));
    await expect(dialog).toContainText('项目将命名为「research-project」');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('目录绑定前保留的阅读问题');
    await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('检索增强，何时有效？');
    await expect(access(join(project, '.read-paper', 'project.json'))).rejects.toHaveProperty('code', 'ENOENT');
    await expect(access(join(userData, 'agents', 'projects.json'))).rejects.toHaveProperty('code', 'ENOENT');

    await navigation(page).getByRole('button', { name: '项目设置 · 检索增强，何时有效？', exact: true }).click();
    await dialog.getByLabel('本机目录路径').fill(project); await dialog.getByRole('button', { name: '打开路径', exact: true }).click();
    await expect(dialog.locator('.directory-preview')).toContainText(await realpath(project));
    await dialog.getByRole('button', { name: '使用这个目录', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await expect(navigation(page).getByRole('button', { name: '项目设置 · research-project', exact: true })).toBeVisible();
    await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-project');
    await expect(main(page).getByRole('heading', { level: 1 })).toHaveText('research-project');
    await expect(page.locator('.breadcrumb').getByText('research-project', { exact: true }).first()).toBeVisible();
    const manifest = JSON.parse(await readFile(join(project, '.read-paper', 'project.json'), 'utf8'));
    const registry = JSON.parse(await readFile(join(userData, 'agents', 'projects.json'), 'utf8'));
    const binding = Object.values(registry.bindings).find((item: unknown) => (item as { researchId?: string }).researchId === 'research-a') as { path: string; projectId: string };
    expect(manifest).toMatchObject({ researchId: 'research-a', version: 1, title: 'research-project' }); expect(binding).toMatchObject({ path: await realpath(project), projectId: manifest.projectId });

    await openSource(page, 'Adaptive Retrieval: Evidence & Reliability'); await expect(main(page).locator('canvas')).toBeVisible();
    const listPromise = page.waitForResponse(response => response.url().endsWith('/api/ai/agents/projects/list') && response.request().method() === 'POST');
    await panel(page).getByRole('button', { name: '查看会话历史', exact: true }).click();
    const list = await listPromise; expect(list.status()).toBe(200); const result = await list.json();
    expect(result.sessions).toEqual([]); expect(Array.isArray(result.errors)).toBe(true);
    expect(list.request().postDataJSON()).toMatchObject({ researchId: 'research-a', workspaceId: manifest.workspaceId });
    await expect(panel(page).getByRole('heading', { name: '对话记录', exact: true })).toBeVisible();
    await expect(panel(page).locator('.ai-history-item')).toHaveCount(1); await expect(panel(page).locator('.ai-history-item')).toContainText('有未发送输入');
    const refreshResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/agents/projects/list') && response.request().method() === 'POST');
    await panel(page).getByRole('button', { name: '刷新', exact: true }).click(); expect((await refreshResponse).status()).toBe(200);
    await expect(panel(page).getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
    await expect(main(page).locator('canvas')).toBeVisible(); await saved(page);
    await mkdir(test.info().outputPath('project-sessions'), { recursive: true }); await page.screenshot({ path: test.info().outputPath('project-sessions', 'desktop-project-entry.png') });
    await panel(page).getByRole('button', { name: '返回当前对话', exact: true }).click(); await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('目录绑定前保留的阅读问题');
    await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click(); await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
    await panel(page).getByLabel('向 AI 提问').fill('原生助手尚未认证，此问题等待以后继续'); await saved(page);
    await close(application); application = undefined;

    session = await launch(userData, home); application = session.application; page = session.page; watch(page);
    await expect(navigation(page).getByRole('button', { name: '项目设置 · research-project', exact: true })).toBeVisible();
    await expect(page.getByLabel('切换研究')).toHaveValue('research-a'); await expect(page.getByLabel('切换研究').locator('option:checked')).toHaveText('research-project');
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue('原生助手尚未认证，此问题等待以后继续');
    await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
    expect(JSON.parse(await readFile(join(project, '.read-paper', 'project.json'), 'utf8')).projectId).toBe(manifest.projectId);
    expect(modelRequests).toEqual([]); expect(pageErrors).toEqual([]);
  } finally {
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});
