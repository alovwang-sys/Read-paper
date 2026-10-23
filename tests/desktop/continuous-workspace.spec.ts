import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chat, composer, inline, installControlledServices, main, openSeedPaper, primaryId, readData, saved, screenshot, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';

const root = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(root, 'Papertrail.app/Contents/MacOS/Papertrail') : join(root, 'Papertrail.exe'));

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-continuous-desktop-'));
  const home = join(directory, 'isolated-home'), userData = join(directory, 'data');
  await Promise.all([mkdir(home), mkdir(userData)]);
  const env = { ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
  let app: ElectronApplication | undefined;
  const runs: Awaited<ReturnType<typeof installControlledServices>>[] = [];
  return {
    async launch(initialize = true) {
      app = await _electron.launch({ executablePath, env, timeout: 60_000 });
      const page = await app.firstWindow();
      const controlled = await installControlledServices(page, { initialize }); runs.push(controlled);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload(); await openSeedPaper(page);
      expect(page.url()).toBe('papertrail://app/');
      expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData);
      expect(await app.evaluate(({ app }) => app.getVersion())).toBe(JSON.parse(await readFile('package.json', 'utf8')).version);
      expect(await page.evaluate(() => typeof Reflect.get(window, 'require'))).toBe('undefined');
      return { page, controlled };
    },
    async close() {
      if (!app) return;
      const instance = app, child = instance.process();
      const exited = instance.waitForEvent('close', { timeout: 30_000 });
      void instance.evaluate(({ app }) => app.quit()).catch(() => {});
      await exited; app = undefined;
      if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
      expect(child.exitCode).toBe(0);
    },
    async dispose() {
      await this.close();
      for (const controlled of runs) controlled.assertClean();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

test('打包桌面：原文旁直接收到回答，同一会话换位置与草稿正常退出后恢复', async () => {
  const f = await fixture();
  try {
    let { page, controlled } = await f.launch();
    await composer(page).fill('桌面原文旁核查检索条件。');
    await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
    await expect(composer(page)).toHaveValue('');
    await expect(chat(page)).toContainText('受控研究回答 1');
    await expect(main(page).locator('.pdf-reader')).toBeVisible();
    expect(controlled.researchCalls).toHaveLength(1);
    await composer(page).fill('退出前最后一条尚未发送的桌面草稿');
    for (const [button, mode] of [['浮窗聊天', 'float'], ['展开聊天', 'main'], ['侧边聊天', 'side']]) {
      await chat(page).getByRole('button', { name: button, exact: true }).click();
      await expect(chat(page)).toHaveAttribute('data-chat-mode', mode);
      await expect(composer(page)).toHaveValue('退出前最后一条尚未发送的桌面草稿');
      await expect(composer(page)).toHaveCount(1);
    }
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
      await page.setViewportSize({ width, height });
      await expect(composer(page)).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await screenshot(page, `desktop-resource-chat-${width}.png`);
    }
    await f.close();
    ({ page } = await f.launch(false));
    await expect(composer(page)).toHaveValue('退出前最后一条尚未发送的桌面草稿');
    await expect(chat(page)).toContainText('受控研究回答 1');
    const restored = await readData(page);
    expect(restored.sessions['research-a'].activeConversationId).toBe(primaryId);
    expect(restored.sessions['research-a'].agentChat?.mode).toBe('side');
    expect(restored.conversations[primaryId].requestIds).toHaveLength(1);
    await screenshot(page, 'desktop-restarted-conversation.png');
  } finally { await f.dispose(); }
});

test('打包桌面：真实原文字形选区翻译、摘要存卡与原位活动记录跨重启保留', async () => {
  const f = await fixture();
  try {
    let { page, controlled } = await f.launch();
    await composer(page).fill('桌面主会话私有草稿');
    await selectPassage(page);
    await selectionMenu(page).getByRole('button', { name: '翻译', exact: true }).click();
    await expect(inline(page, '翻译')).toContainText('受控翻译');
    await expect(composer(page)).toHaveValue('桌面主会话私有草稿');
    await inline(page, '翻译').getByRole('button', { name: '关闭就地问答并保留内容' }).click();
    await selectPassage(page);
    await selectionMenu(page).getByRole('button', { name: '摘要卡片', exact: true }).click();
    await expect(inline(page, '摘要卡片').getByLabel('就地卡片正文')).toHaveValue(/受控摘要/);
    await inline(page, '摘要卡片').getByLabel('就地卡片标题').fill('桌面重启保留的摘要卡片');
    await inline(page, '摘要卡片').getByRole('button', { name: '保存卡片', exact: true }).click();
    await expect(inline(page, '摘要卡片')).toContainText('已加入当前研究的卡片');
    await inline(page, '摘要卡片').getByRole('button', { name: '关闭就地问答并保留内容' }).click();
    expect(JSON.stringify(controlled.localCalls)).not.toContain('桌面主会话私有草稿');
    const before = await readData(page);
    const card = Object.values(before.cards).find(card => card.title === '桌面重启保留的摘要卡片')!;
    expect(card).toBeTruthy(); expect(card.evidenceIds.length).toBeGreaterThan(0);
    await saved(page); await screenshot(page, 'desktop-source-activity-before-restart.png');
    await f.close();
    ({ page } = await f.launch(false));
    await expect(composer(page)).toHaveValue('桌面主会话私有草稿');
    expect((await readData(page)).cards[card.id]).toEqual(card);
    await page.getByRole('button', { name: /^查看此处记录 · / }).first().click();
    const activities = page.getByLabel('此处操作记录', { exact: true });
    await expect(activities).toContainText('翻译'); await expect(activities).toContainText('摘要卡片');
    await activities.getByRole('button', { name: /摘要卡片/ }).first().click();
    await expect(inline(page, '摘要卡片')).toContainText('受控摘要');
    await screenshot(page, 'desktop-source-activity-after-restart.png');
  } finally { await f.dispose(); }
});

test('打包桌面：手动命名不被首问覆盖，取消改名与正常退出后保留会话和草稿', async () => {
  const f = await fixture();
  const evidence = 'docs/verification/conversation-renaming/screenshots';
  try {
    let { page, controlled } = await f.launch();
    const before = await readData(page), id = before.sessions['research-a'].activeConversationId!;
    const draft = '桌面改名后仍保留的未发送草稿';
    await composer(page).fill(draft);
    await chat(page).getByRole('button', { name: `重命名会话：${before.conversations[id].title}`, exact: true }).click();
    const rename = () => page.getByRole('dialog', { name: '重命名会话', exact: true });
    await rename().getByLabel('会话名称', { exact: true }).fill('新会话');
    await rename().getByLabel('会话名称', { exact: true }).press('Enter');
    await expect(rename()).toHaveCount(0);
    await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText('新会话');
    await expect(composer(page)).toHaveValue(draft);
    await saved(page);
    const renamed = await readData(page);
    expect(renamed.sessions['research-a'].activeConversationId).toBe(id);
    expect(renamed.conversations[id]).toEqual({ ...before.conversations[id], input: draft, title: '新会话', titleEdited: true });

    await chat(page).getByRole('button', { name: '重命名会话：新会话', exact: true }).click();
    await rename().getByLabel('会话名称', { exact: true }).fill('不应保存的名称');
    await rename().getByLabel('会话名称', { exact: true }).press('Escape');
    await expect(rename()).toHaveCount(0);
    await expect(chat(page).getByRole('button', { name: '重命名会话：新会话', exact: true })).toBeFocused();
    await expect(composer(page)).toHaveValue(draft);
    expect((await readData(page)).conversations[id]).toEqual(renamed.conversations[id]);

    await composer(page).fill('首次提问不应覆盖手动设置的新会话名称。');
    await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
    await expect(chat(page)).toContainText('受控研究回答 1');
    await expect(composer(page)).toHaveValue('');
    expect(controlled.researchCalls).toHaveLength(1);
    await composer(page).fill(draft);
    await saved(page);
    const answered = await readData(page);
    expect(answered.sessions['research-a'].activeConversationId).toBe(id);
    expect(answered.conversations[id]).toMatchObject({ title: '新会话', titleEdited: true, input: draft });
    expect(answered.conversations[id].requestIds).toHaveLength(1);
    await expect(main(page).locator('.pdf-reader')).toBeVisible();
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/desktop-rename-before-restart.png` });

    await f.close();
    ({ page } = await f.launch(false));
    await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText('新会话');
    await expect(chat(page)).toContainText('受控研究回答 1');
    await expect(composer(page)).toHaveValue(draft);
    await expect(main(page).locator('.pdf-reader')).toBeVisible();
    const restored = await readData(page);
    expect(restored.sessions['research-a'].activeConversationId).toBe(id);
    expect(restored.conversations[id]).toEqual(answered.conversations[id]);
    expect(restored.requests[answered.conversations[id].requestIds[0]]).toEqual(answered.requests[answered.conversations[id].requestIds[0]]);
    await page.screenshot({ path: `${evidence}/desktop-rename-after-restart.png` });
  } finally { await f.dispose(); }
});
