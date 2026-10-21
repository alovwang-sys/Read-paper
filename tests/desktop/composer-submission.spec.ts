import { useClassicWorkbench } from './helpers';
import { test, expect, _electron, type ElectronApplication, type Page, type Route } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
type Chat = { requestId: string; messages: { role: string; content: string }[] };

async function launch(userData: string, isolatedHome: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: isolatedHome, CODEX_HOME: join(isolatedHome, '.codex'), CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'), XDG_DATA_HOME: join(isolatedHome, '.local/share'), XDG_CACHE_HOME: join(isolatedHome, '.cache'), XDG_STATE_HOME: join(isolatedHome, '.local/state'),
    OPENCODE_CONFIG_DIR: join(isolatedHome, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible(); await useClassicWorkbench(page); await saved(page);
    return { application, page };
  } catch (error) { const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error; }
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited;
}

test('打包桌面：长问题完整提交、挂起时可写下一条，网络失败恢复且重启保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-submission-'));
  const userData = join(directory, 'app-data'), isolatedHome = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(isolatedHome)]);
  let application: ElectronApplication | undefined;
  const requests: Chat[] = [], pending: Route[] = [], pageErrors: string[] = [];
  try {
    let session = await launch(userData, isolatedHome); application = session.application; let page = session.page;
    page.on('pageerror', error => pageErrors.push(error.message));
    expect(page.url()).toBe('papertrail://app/');
    await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, images: false, model: '桌面模拟模型', provider: 'fixture', mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
    await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/ai/chat', route => { requests.push(route.request().postDataJSON() as Chat); pending.push(route); });
    await page.reload(); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    const prompt = '桌面长问题完整传输测试，保留全部中文研究条件。'.repeat(300) + '末尾完整性校验。';
    expect(prompt.length).toBeGreaterThan(6000);
    await input(page).fill(prompt); await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0].messages.at(-1)?.content).toBe(prompt);
    await expect(input(page)).toHaveValue(''); await expect(input(page)).toBeEditable();
    const nextDraft = '桌面下一条草稿：网络失败后需要完整恢复。';
    await input(page).fill(nextDraft);
    await pending[0].fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'delta', text: '桌面模拟响应：长问题已完整接收。' }) + '\n' + JSON.stringify({ type: 'done', model: '桌面模拟模型' }) + '\n' });
    await expect(panel(page).locator('.ai-answer')).toContainText('长问题已完整接收');
    await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(input(page)).toHaveValue(nextDraft);
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2); await expect(input(page)).toHaveValue('');
    await pending[1].abort('failed');
    await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    await expect(input(page)).toHaveValue(nextDraft); await saved(page);
    await mkdir('docs/verification/composer-fixes', { recursive: true });
    await page.screenshot({ path: 'docs/verification/composer-fixes/desktop-composer.png' });
    await close(application); application = undefined;
    session = await launch(userData, isolatedHome); application = session.application; page = session.page;
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(input(page)).toHaveValue(nextDraft);
    expect(requests).toHaveLength(2); expect(pageErrors).toEqual([]);
    await writeFile('docs/verification/composer-fixes/desktop-evidence.json', JSON.stringify({
      executablePath, protocol: 'papertrail://app/', promptCharacters: prompt.length,
      fullPromptReceived: requests[0].messages.at(-1)?.content === prompt,
      requestCount: requests.length, clearedWhilePending: true, subsequentDraftPreservedOnSuccess: true,
      originalInputRestoredOnNetworkError: true, draftRetainedAfterRestart: true,
      actualModelCalls: 0, pageErrors,
    }, null, 2) + '\n');
  } finally {
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
