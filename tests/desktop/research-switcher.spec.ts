import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openResearchNavigation, switchResearch } from '../e2e/knowledge-helpers';
import { state } from '../e2e/workspace-split-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin' ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const trigger = (page: Page) => page.getByRole('button', { name: '切换研究', exact: true, includeHidden: true });
const popup = (page: Page) => page.getByRole('dialog', { name: '切换研究', exact: true });
const researchName = (page: Page) => page.getByRole('textbox', { name: '研究名称', exact: true });
const composer = (page: Page) => page.getByRole('textbox', { name: '研究目标', exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-navigation-desktop-'));
  const home = join(directory, 'isolated-home');
  await mkdir(home);
  const env = {
    ...process.env, PAPERTRAIL_USER_DATA: join(directory, 'data'), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  };
  const modelRequests: string[] = [], pageErrors: string[] = [];
  let application: ElectronApplication | undefined;
  async function close() {
    if (!application) return;
    const current = application;
    const exited = current.waitForEvent('close', { timeout: 20_000 });
    void current.evaluate(({ app }) => app.quit()).catch(() => {});
    await exited;
    application = undefined;
  }
  return {
    async launch() {
      application = await _electron.launch({ executablePath, env, timeout: 60_000 });
      const context = application.context();
      context.on('request', request => {
        if (/\/api\/ai\/(?:chat|agents\/run|research\/run)$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url());
      });
      // Unexpected model requests fail the test and cannot leave the isolated app.
      await context.route(/\/api\/ai\/(?:chat|agents\/run|research\/run)(?:\?|$)/, route => route.fulfill({ status: 500, json: { error: 'Navigation tests must not send model requests' } }));
      const page = await application.firstWindow();
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(main(page)).toBeVisible();
      await expect(page.locator('.app-shell.agent-workbench')).toBeVisible();
      await expect(composer(page)).toBeVisible();
      await saved(page);
      expect(page.url()).toBe('papertrail://app/');
      expect(await page.evaluate(async () => (await fetch('/api/ai/config')).json())).toMatchObject({ configured: false });
      return page;
    },
    close,
    check() { expect(modelRequests).toEqual([]); expect(pageErrors).toEqual([]); },
    async dispose() {
      await close();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function screenshot(page: Page, name: string) {
  await mkdir(test.info().outputPath('research-switcher'), { recursive: true });
  await page.screenshot({ path: test.info().outputPath('research-switcher', name) });
}

test('打包桌面：研究切换键盘、重复点击收起、窄屏空白点击后Esc逐层关闭', async () => {
  const f = await fixture();
  try {
    const page = await f.launch();
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
      await page.setViewportSize({ width, height });
      const sidebar = await openResearchNavigation(page);
      await trigger(page).click();
      await expect(popup(page).getByRole('textbox', { name: '查找研究' })).toBeFocused();
      await expect(popup(page).locator('button[data-research-id="research-a"]')).toHaveAttribute('aria-current', 'true');
      await expect(popup(page).locator('select')).toHaveCount(0);
      const bounds = (await popup(page).boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      await screenshot(page, `desktop-switcher-${width}.png`);

      await trigger(page).click();
      await expect(popup(page)).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
      await trigger(page).press('ArrowDown');
      await expect(popup(page).getByRole('textbox', { name: '查找研究' })).toBeFocused();
      await popup(page).locator('.research-switcher-caption').click();
      await expect(popup(page).getByRole('textbox', { name: '查找研究' })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(popup(page)).toHaveCount(0);
      await expect(sidebar).toBeVisible();
      await expect(trigger(page)).toBeFocused();
      if (width === 1024) {
        await page.keyboard.press('Escape');
        await expect(sidebar).toBeHidden();
        await expect(page.getByRole('button', { name: '展开左栏', exact: true })).toBeFocused();
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await openResearchNavigation(page);
    await trigger(page).click();
    await popup(page).getByRole('textbox', { name: '查找研究' }).fill('长文本阅读');
    await expect(popup(page).locator('button[data-research-id]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(popup(page).locator('button[data-research-id="research-b"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(popup(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute('data-research-id', 'research-b');
    await saved(page);
    f.check();
  } finally { await f.dispose(); }
});

test('打包桌面：新研究命名、空名和取消保护，多研究与资料库草稿退出重启恢复', async () => {
  const f = await fixture();
  try {
    let page = await f.launch();
    const original = await researchName(page).inputValue();
    await researchName(page).fill('');
    await researchName(page).press('Enter');
    await expect(researchName(page)).toHaveValue(original);
    await researchName(page).fill('应取消的研究名称');
    await researchName(page).press('Escape');
    await expect(researchName(page)).toHaveValue(original);
    await researchName(page).fill('  桌面研究 A  ');
    await researchName(page).press('Enter');
    await expect(researchName(page)).toHaveValue('桌面研究 A');
    await composer(page).fill('研究 A 的未发送问题');
    await switchResearch(page, 'research-b');
    await composer(page).fill('研究 B 的未发送问题');
    await switchResearch(page, 'research-a');
    await expect(composer(page)).toHaveValue('研究 A 的未发送问题');
    await page.getByRole('button', { name: '资料库', exact: true }).click();
    await expect(trigger(page)).toContainText('全局资料库');
    await switchResearch(page, 'research-b');
    await expect(composer(page)).toHaveValue('研究 B 的未发送问题');

    for (const title of ['新研究', '新研究 2']) {
      await page.getByRole('button', { name: '新建研究', exact: true }).click();
      await expect(researchName(page)).toHaveValue(title);
      await expect(researchName(page)).toBeFocused();
      await expect(page.getByRole('dialog', { name: '新建研究', exact: true })).toHaveCount(0);
    }
    await composer(page).fill('新研究 2 的独立草稿');
    await saved(page);
    const before = await state(page);
    if (before.scope.kind !== 'research') throw new Error('Expected a current research');
    const lastId = before.scope.researchId;
    expect(Object.values(before.researches).filter(item => item.title.startsWith('新研究')).map(item => item.title)).toEqual(['新研究', '新研究 2']);
    await screenshot(page, 'desktop-drafts-before-restart.png');
    await f.close();

    page = await f.launch();
    await expect(trigger(page)).toHaveAttribute('data-research-id', lastId);
    await expect(researchName(page)).toHaveValue('新研究 2');
    await expect(composer(page)).toHaveValue('新研究 2 的独立草稿');
    await switchResearch(page, 'research-a');
    await expect(researchName(page)).toHaveValue('桌面研究 A');
    await expect(composer(page)).toHaveValue('研究 A 的未发送问题');
    await switchResearch(page, 'research-b');
    await expect(composer(page)).toHaveValue('研究 B 的未发送问题');
    await switchResearch(page, lastId);
    await expect(composer(page)).toHaveValue('新研究 2 的独立草稿');
    await screenshot(page, 'desktop-drafts-after-restart.png');
    f.check();
  } finally { await f.dispose(); }
});

test('打包桌面：研究名称仍聚焦且未按Enter，直接正常退出后保留编辑', async () => {
  const f = await fixture();
  try {
    let page = await f.launch();
    await researchName(page).fill('直接退出前正在编辑的研究名称');
    await expect(researchName(page)).toBeFocused();
    // Do not press Enter, click elsewhere or manually blur: exercise the real quit lifecycle.
    await f.close();
    page = await f.launch();
    await expect(researchName(page)).toHaveValue('直接退出前正在编辑的研究名称');
    await expect(trigger(page)).toContainText('直接退出前正在编辑的研究名称');
    await screenshot(page, 'desktop-focused-name-after-quit.png');
    f.check();
  } finally { await f.dispose(); }
});
