import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin' ? join(root, 'Papertrail.app/Contents/MacOS/Papertrail') : join(root, 'Papertrail.exe'));
async function close(application: ElectronApplication) { const exited = application.waitForEvent('close'); void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited; }

test('默认Agent桌面长消息、全文回复、文献收录和新草稿重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-agent-regression-'));
  const home = join(directory, 'isolated-home');
  await mkdir(home);
  let application: ElectronApplication | undefined;
  const errors: string[] = [];
  const env = { ...process.env, PAPERTRAIL_USER_DATA: join(directory, 'data'), HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'), OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '', AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
  try {
    application = await _electron.launch({ executablePath, env, timeout: 60_000 });
    let page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [{ id: 'codex', research: true, detail: '受控桌面回归' }] } }));
    await page.route('**/api/sources/resolve', route => route.fulfill({ json: { url: 'https://doi.org/10.1234/desktop-regression', title: '桌面受控文献', kind: 'paper', identifiers: { doi: '10.1234/desktop-regression' }, warning: '桌面受控测试：未获取全文。' } }));
    await page.route('**/api/sources/pdf', route => route.fulfill({ status: 404, json: { error: '桌面受控测试：没有 PDF。' } }));
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let prompt = '';
    await page.route('**/api/ai/research/run', async route => {
      prompt = route.request().postDataJSON().prompt;
      await held;
      await route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'artifact', artifact: { title: '桌面完整成果', body: '## 桌面回复正文\n\n完整结论直接留在会话里。可阅读 [论文](https://doi.org/10.1234/desktop-regression)。', citations: [] } },
        { type: 'done', readPages: [] },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await page.reload();
    const input = () => page.getByRole('textbox', { name: '研究目标', exact: true });
    await expect(input()).toBeVisible();
    const question = '桌面长消息需要完整发送，并清空已发送的内容。'.repeat(450);
    expect(question.length).toBeGreaterThan(8000);
    await input().fill(question);
    await page.getByRole('button', { name: '开始研究', exact: true }).click();
    await expect(input()).toHaveValue('');
    await expect.poll(() => prompt).toBe(question);
    await input().fill('桌面下一条尚未发送的新草稿');
    release();
    await expect(page.getByText('完整结论直接留在会话里。可阅读', { exact: false })).toBeVisible();
    const sources = page.getByRole('region', { name: '回答中的资料' });
    await sources.getByRole('button', { name: '加入本研究', exact: true }).click();
    await expect(sources.getByText('已在本研究', { exact: true })).toBeVisible();
    await expect(input()).toHaveValue('桌面下一条尚未发送的新草稿');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await mkdir('docs/verification/agent-regressions/screenshots', { recursive: true });
    await page.screenshot({ path: 'docs/verification/agent-regressions/screenshots/desktop-agent-1440.png' });
    await close(application); application = undefined;
    application = await _electron.launch({ executablePath, env, timeout: 60_000 });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await expect(input()).toHaveValue('桌面下一条尚未发送的新草稿');
    await expect(page.getByText('完整结论直接留在会话里。可阅读', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: '回答中的资料' }).getByText('已在本研究', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
