import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { listPackage } from '@electron/asar';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openSource } from '../e2e/knowledge-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const inline = (page: Page) => page.getByRole('dialog', { name: '原文旁提问' });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function close(application: ElectronApplication) {
  const child = application.process();
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
  if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
  expect(child.exitCode).toBe(0);
}

test('打包桌面：内置 Pi 真实启动、就地解释、右侧输入隔离与正常退出重启', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'papertrail-inline-desktop-'));
  const userData = join(temporary, 'app-data'), bin = join(temporary, 'bin');
  await Promise.all([mkdir(userData), mkdir(bin)]);
  const unavailable = join(bin, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await writeFile(unavailable, process.platform === 'win32' ? '@exit /b 127\r\n' : '#!/bin/sh\nexit 127\n', { mode: 0o700 });
  const env = { ...process.env, PAPERTRAIL_USER_DATA: userData, PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}`,
    CLAUDE_BIN: unavailable, OPENCODE_BIN: unavailable, AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
  let application: ElectronApplication | undefined;
  let mockedCalls = 0, nativeRuns = 0, closes = 0;
  const pageErrors: string[] = [];
  const rightDraft = '桌面右侧原有问题，暂时不发送。';
  const answer = '这是桌面交互测试的固定回答：证据的相关性决定检索是否帮助回答问题。 [1]';
  async function launch() {
    const app = await _electron.launch({ executablePath, env, timeout: 60_000 });
    application = app;
    const page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
    await saved(page);
    expect(page.url()).toBe('papertrail://app/');
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
    return page;
  }
  try {
    const asar = process.platform === 'darwin' ? resolve(dirname(executablePath), '../Resources/app.asar') : join(dirname(executablePath), 'resources/app.asar');
    const entries = listPackage(asar, { isPack: false }).map(name => name.replaceAll('\\', '/'));
    for (const file of ['/server/pi-runtime.mjs', '/node_modules/@earendil-works/pi-agent-core/package.json', '/node_modules/@earendil-works/pi-ai/package.json']) expect(entries).toContain(file);

    let page = await launch();
    const productionConfig = await page.evaluate(async () => (await fetch('/api/ai/config')).json());
    expect(productionConfig).toMatchObject({ configured: false, runtime: 'pi', tools: [], model: 'glm-5.3-flash' });
    const unconfigured = await page.evaluate(async () => {
      const response = await fetch('/api/ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'desktop-unconfigured', purpose: 'chat', messages: [{ role: 'user', content: '只验证未配置错误。' }] }) });
      return { status: response.status, events: (await response.text()).trim().split('\n').map(line => JSON.parse(line)) };
    });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.events).toMatchObject([{ type: 'error', code: 'not_configured' }]);
    expect(JSON.stringify(unconfigured)).not.toMatch(/CLI|本机 Agent 连接失败/);

    await page.route('**/api/ai/config', route => route.fulfill({ json: { ...productionConfig, configured: true, mode: 'live' } }));
    await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
    await page.route('**/api/ai/agents/run', route => { nativeRuns++; return route.fulfill({ status: 500, body: 'Unexpected native call' }); });
    await page.route('**/api/ai/chat', route => {
      mockedCalls++;
      const payload = route.request().postDataJSON();
      expect(JSON.stringify(payload)).not.toContain(rightDraft);
      return route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'delta', text: answer }, { type: 'done', model: 'glm-5.3-flash' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await page.reload();
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await panel(page).getByLabel('向 AI 提问', { exact: true }).fill(rightDraft);
    await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
    const span = page.locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first();
    await expect(span).toBeVisible();
    await expect(page.locator('.pdf-page-loading')).toHaveCount(0);
    const bounds = (await span.boundingBox())!;
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByLabel('原文选区操作', { exact: true })).toBeVisible();
    await page.getByLabel('原文选区操作', { exact: true }).getByRole('button', { name: '解释这段', exact: true }).click();
    await expect(inline(page)).toContainText(answer.replace(' [1]', ''));
    await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue(rightDraft);
    expect(mockedCalls).toBe(1);
    expect(nativeRuns).toBe(0);
    await saved(page);
    await mkdir('docs/verification/inline-ai', { recursive: true });
    await page.screenshot({ path: 'docs/verification/inline-ai/desktop-answer-1440.png' });
    await close(application!); application = undefined; closes++;

    page = await launch();
    await page.getByRole('button', { name: '上次提问', exact: true }).click();
    await expect(inline(page)).toContainText(answer.replace(' [1]', ''));
    await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue(rightDraft);
    await saved(page);
    await page.screenshot({ path: 'docs/verification/inline-ai/desktop-restored-1440.png' });
    await close(application!); application = undefined; closes++;
    expect(pageErrors).toEqual([]);
    await writeFile('docs/verification/inline-ai/desktop-smoke.json', JSON.stringify({
      executablePath, protocol: 'papertrail://app/', isolatedUserData: true, packagedPiRuntime: true,
      productionConfig, unconfigured, mockedModelResponses: mockedCalls, actualModelCalls: 0,
      nativeRuns, rightDraftPreserved: true, inlineAnswerRestoredAfterRestart: true,
      normalLaunches: 2, normalExitCount: closes, normalExitCode: 0, pageErrors,
    }, null, 2) + '\n');
  } finally {
    const child = application?.process();
    try { if (application) await close(application); }
    finally {
      if (child?.exitCode === null) child.kill('SIGKILL');
      await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
