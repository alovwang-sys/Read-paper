import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const menu = (page: Page) => panel(page).getByRole('dialog', { name: 'Codex 操作与技能', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function launch(userData: string, home: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible(); await saved(page);
    return { application, page };
  } catch (error) {
    const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error;
  }
}

async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited;
}

// Observe accidental recording attempts without ever requesting an OS microphone permission.
async function observeMedia(page: Page) {
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(window, '__composerMediaRequests', { configurable: true, get: () => calls });
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => {
      calls++; throw new Error('This desktop test must never request recording');
    };
  });
}

test('打包桌面：原生输入控件可达，取消权限与材料、系统听写及重启均保留草稿', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-composer-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(join(home, '.codex'), { recursive: true })]);
  let application: ElectronApplication | undefined;
  const modelRequests: string[] = [], pageErrors: string[] = [];
  const watch = (page: Page) => {
    page.on('request', request => { if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url()); });
    page.on('pageerror', error => pageErrors.push(error.message));
  };
  const draft = '原生输入控件验收：保留尚未发送的研究问题';
  try {
    let session = await launch(userData, home); application = session.application; let page = session.page; watch(page); await observeMedia(page);
    expect(page.url()).toBe('papertrail://app/');
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    const capabilityResponse = page.waitForResponse(response => response.url().endsWith('/api/ai/agents/codex/capabilities') && response.request().method() === 'GET');
    await panel(page).getByRole('button', { name: '切换 AI 助手', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Codex', exact: true }).click();
    const response = await capabilityResponse;
    const capability: { accessModes?: string[]; models?: { id: string }[]; error?: string; code?: string } = await response.json();
    const capabilityStatus = response.status();
    if (capabilityStatus === 200) expect(Array.isArray(capability.models)).toBe(true);
    else { expect(capabilityStatus, JSON.stringify(capability)).toBe(502); expect(capability.error).toBeTruthy(); }
    const capabilityBranch = capabilityStatus !== 200 ? 'unavailable' : capability.accessModes?.includes('full-access') ? 'full-access-cancel' : 'read-only';
    let fullAccessConfirmationCancelled = false;
    console.info('Packaged Codex metadata', { capabilityStatus, capabilityBranch, modelCount: capability.models?.length ?? null });
    await input(page).fill(draft);

    for (const name of ['添加材料', 'Codex 访问权限', '选择 Codex 模型', '语音输入', '发送问题']) {
      await expect(panel(page).getByRole('button', { name, exact: true })).toBeVisible();
    }
    await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
    await panel(page).getByRole('button', { name: '添加材料', exact: true }).click();
    const materials = panel(page).getByRole('dialog', { name: '添加对话材料', exact: true });
    await expect(materials.getByLabel('搜索研究证据')).toBeVisible();
    await materials.getByRole('button', { name: '关闭添加材料', exact: true }).click();
    await expect(materials).not.toBeVisible(); await expect(input(page)).toHaveValue(draft);
    await expect(panel(page).getByText('本轮材料 · 0', { exact: true })).toBeVisible();

    const permissions = panel(page).getByRole('button', { name: 'Codex 访问权限', exact: true });
    await permissions.click(); await expect(menu(page)).toContainText('仅影响当前对话的后续请求');
    if (capabilityStatus === 200 && capability.accessModes?.includes('full-access')) {
      await menu(page).getByRole('option', { name: /^完全访问/ }).click();
      const confirmation = panel(page).getByRole('dialog', { name: '启用完全访问', exact: true });
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('修改项目外的文件、执行命令及访问网络');
      await confirmation.getByRole('button', { name: '保留当前权限', exact: true }).click();
      await expect(confirmation).not.toBeVisible(); await expect(permissions).toBeFocused();
      fullAccessConfirmationCancelled = true;
    } else {
      await expect(menu(page).getByRole('option', { name: /^只读权限/ })).toBeVisible();
      if (capabilityStatus !== 200) {
        await expect(menu(page).getByRole('alert')).toContainText(capability.error!);
        await expect(menu(page).getByRole('button', { name: '重新读取能力', exact: true })).toBeEnabled();
        await expect(menu(page).getByRole('option', { name: /^只读权限/ })).toHaveAttribute('aria-disabled', 'true');
        await expect(menu(page).getByRole('option', { name: /^完全访问/ })).toHaveCount(0);
      }
      await menu(page).press('Escape');
    }
    await expect(permissions).toContainText('只读权限'); await expect(input(page)).toHaveValue(draft);
    await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click();
    await expect(menu(page)).toContainText('Codex 模型');
    await expect(menu(page).getByRole('option')).toHaveCount(capability.models?.length ?? 0);
    if (capabilityStatus !== 200) {
      await expect(menu(page).getByRole('alert')).toContainText(capability.error!);
      await expect(menu(page).getByRole('button', { name: '重新读取能力', exact: true })).toBeEnabled();
    }
    await menu(page).press('Escape'); await expect(input(page)).toHaveValue(draft);

    await panel(page).getByRole('button', { name: '语音输入', exact: true }).click();
    await expect(panel(page).locator('.ai-voice-hint')).toContainText('使用系统听写');
    await expect(panel(page).locator('.ai-voice-hint')).toContainText('识别文字留在草稿，不自动发送');
    await expect(input(page)).toBeFocused(); await input(page).press('Escape');
    await expect(panel(page).locator('.ai-voice-hint')).toHaveCount(0); await expect(panel(page)).toBeVisible();
    await expect(input(page)).toHaveValue(draft);
    expect(await page.evaluate(() => Reflect.get(window, '__composerMediaRequests'))).toBe(0);

    await page.getByRole('main', { name: '主工作区' }).getByRole('button', { name: /Adaptive Retrieval: Evidence & Reliability/ }).click();
    await expect(page.getByRole('main', { name: '主工作区' }).locator('canvas')).toBeVisible();
    const notice = page.getByRole('button', { name: '关闭提示', exact: true });
    await expect(notice).not.toBeVisible();
    await page.setViewportSize({ width: 1024, height: 800 });
    for (const name of ['添加材料', 'Codex 访问权限', '选择 Codex 模型', '语音输入', '发送问题']) {
      const button = panel(page).getByRole('button', { name, exact: true }); await expect(button).toBeVisible();
      const bounds = await button.boundingBox(); expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1025); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(801);
      expect(bounds!.width).toBeGreaterThanOrEqual(36); expect(bounds!.height).toBeGreaterThanOrEqual(36);
    }
    await panel(page).getByRole('button', { name: '选择 Codex 模型', exact: true }).click();
    await expect(menu(page)).toBeVisible(); await menu(page).press('Escape');
    await permissions.click(); await expect(menu(page)).toBeVisible(); await menu(page).press('Escape');
    await panel(page).getByRole('button', { name: '添加材料', exact: true }).click();
    await expect(materials).toBeVisible(); await materials.press('Escape'); await expect(materials).not.toBeVisible();
    await expect(panel(page).getByRole('button', { name: '语音输入', exact: true })).toBeEnabled();
    await panel(page).getByRole('button', { name: '语音输入', exact: true }).click(); await expect(input(page)).toBeFocused(); await input(page).press('Escape');
    await expect(input(page)).toHaveValue(draft); await saved(page);
    await mkdir('docs/verification/native-composer', { recursive: true });
    await page.screenshot({ path: 'docs/verification/native-composer/desktop-composer.png' });
    expect(await page.evaluate(() => Reflect.get(window, '__composerMediaRequests'))).toBe(0);
    await close(application); application = undefined;

    session = await launch(userData, home); application = session.application; page = session.page; watch(page); await observeMedia(page);
    await expect(input(page)).toHaveValue(draft); await expect(panel(page).getByRole('button', { name: '切换 AI 助手', exact: true })).toContainText('Codex');
    await expect(panel(page).getByRole('button', { name: 'Codex 访问权限', exact: true })).toContainText('只读权限');
    await expect(panel(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
    expect(modelRequests).toEqual([]); expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => Reflect.get(window, '__composerMediaRequests'))).toBe(0);
    await writeFile('docs/verification/native-composer/desktop-composer-evidence.json', JSON.stringify({
      executablePath, capabilityStatus, capabilityBranch, capabilityError: capabilityStatus === 200 ? null : capability.error,
      capabilityErrorCode: capabilityStatus === 200 ? null : capability.code, modelCount: capability.models?.length ?? null,
      fullAccessConfirmationCancelled, fullAccessEnabled: false, materialDialogCancelled: true,
      systemDictationMediaRequests: 0, modelRequests, pageErrors, viewport: { width: 1024, height: 800 },
      controlsReachableAt1024: true, draftRetainedAfterRestart: true, permissionAfterRestart: 'read-only',
    }, null, 2) + '\n');
  } finally {
    if (application) await close(application);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
