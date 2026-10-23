import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { chat, composer, controlledSeed, inline, installControlledServices, main, openSeedPaper, primaryId, readData, saved, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';
import { openResearchNavigation } from './knowledge-helpers';

test.use({ storageState: { cookies: [], origins: [] } });
const rename = (page: Page) => page.getByRole('dialog', { name: '重命名会话', exact: true });
const nameInput = (page: Page) => rename(page).getByRole('textbox', { name: '会话名称', exact: true });
async function saveName(page: Page, title: string) {
  await nameInput(page).fill(title);
  await rename(page).getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(rename(page)).toHaveCount(0); await saved(page);
}
async function shot(page: Page, name: string) {
  await mkdir('docs/verification/conversation-renaming/screenshots', { recursive: true });
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/conversation-renaming/screenshots/${name}.png` });
}

test('侧栏改名支持取消、空名、中文组合输入与Enter，首轮回答和刷新不覆盖“新会话”', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('改名不会消费这段草稿'); await saved(page);
  const before = await readData(page);
  const list = (await openResearchNavigation(page)).getByRole('region', { name: '研究会话列表', exact: true });
  const trigger = list.getByRole('button', { name: '重命名会话：条件比较 A', exact: true });
  await trigger.click(); await expect(nameInput(page)).toBeFocused();
  await nameInput(page).fill('取消后不应保存'); await nameInput(page).press('Escape');
  await expect(rename(page)).toHaveCount(0); await expect(trigger).toBeFocused();
  expect((await readData(page)).conversations[primaryId].title).toBe('条件比较 A');
  await trigger.click(); await nameInput(page).fill('   ');
  await expect(rename(page).getByRole('button', { name: '保存名称', exact: true })).toBeDisabled();
  await nameInput(page).press('Enter'); await expect(rename(page)).toBeVisible();
  await rename(page).getByRole('button', { name: '取消', exact: true }).click();
  await trigger.click(); await nameInput(page).fill('检索条件与来源核对');
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(nameInput(page)).toBeInViewport({ ratio: 1 });
    await expect(rename(page).getByRole('button', { name: '保存名称', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `rename-dialog-${width}`);
  }
  // Dispatch composition events to exercise the IME guard; no OS input method is invoked.
  await nameInput(page).dispatchEvent('compositionstart'); await nameInput(page).fill('新会话');
  await nameInput(page).press('Enter'); await expect(rename(page)).toBeVisible();
  expect((await readData(page)).conversations[primaryId].title).toBe('条件比较 A');
  await nameInput(page).dispatchEvent('compositionend'); await nameInput(page).press('Enter');
  await expect(rename(page)).toHaveCount(0); await saved(page);
  const changed = await readData(page);
  expect(changed.conversations[primaryId]).toEqual({ ...before.conversations[primaryId], title: '新会话', titleEdited: true });
  expect(changed.requests).toEqual(before.requests);
  expect(changed.sessions['research-a'].activeConversationId).toBe(primaryId);
  expect(changed.sessions['research-a'].layout).toEqual(before.sessions['research-a'].layout);
  expect(changed.sessions['research-b']).toEqual(before.sessions['research-b']);
  await expect(composer(page)).toHaveValue('改名不会消费这段草稿');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText('新会话');
  await composer(page).fill('第一条研究问题，不应替换手动名');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(chat(page)).toContainText('受控研究回答 1');
  await composer(page).fill('刷新后仍保留的后续草稿'); await saved(page); await page.reload(); await openSeedPaper(page);
  await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText('新会话');
  await expect(chat(page)).toContainText('受控研究回答 1');
  await expect(composer(page)).toHaveValue('刷新后仍保留的后续草稿');
  expect((await readData(page)).sessions['research-a'].activeConversationId).toBe(primaryId);
  fixture.assertClean();
});

test('卡片讨论自定义名在侧栏与侧边、浮窗、完整聊天同步显示，来源和草稿保持', async ({ page }) => {
  const seed = controlledSeed();
  Object.assign(seed.conversations[primaryId], { title: '原始卡片讨论', anchor: { kind: 'card', id: 'card-a' }, input: '讨论里的未发送草稿' });
  const fixture = await installControlledServices(page, { seed });
  await page.goto('/'); await openSeedPaper(page);
  const before = await readData(page);
  const list = (await openResearchNavigation(page)).getByRole('region', { name: '研究会话列表', exact: true });
  const initialRename = list.getByRole('button', { name: `重命名会话：${seed.cards['card-a'].title}`, exact: true });
  if (!await initialRename.isVisible()) await list.getByText('讨论（1）', { exact: true }).click();
  await initialRename.click();
  await saveName(page, '需要核对的适用条件');
  await expect(list.getByRole('button', { name: '打开讨论：需要核对的适用条件', exact: true })).toBeVisible();
  let previous = '需要核对的适用条件';
  for (const [mode, control, title] of [['side', '侧边聊天', '侧边讨论名称'], ['float', '浮窗聊天', '浮窗讨论名称'], ['main', '展开聊天', '完整讨论名称']]) {
    await chat(page).getByRole('button', { name: control, exact: true }).click();
    await expect(chat(page)).toHaveAttribute('data-chat-mode', mode);
    await chat(page).getByRole('button', { name: `重命名会话：${previous}`, exact: true }).click();
    await saveName(page, title);
    await expect(chat(page).getByRole('button', { name: '选择会话', exact: true })).toContainText(title);
    await expect(composer(page)).toHaveValue('讨论里的未发送草稿');
    await expect(list.getByRole('button', { name: `打开讨论：${title}`, exact: true })).toBeVisible();
    const after = await readData(page);
    expect(Object.keys(after.conversations)).toEqual(Object.keys(before.conversations));
    expect(after.sessions['research-a'].activeConversationId).toBe(primaryId);
    expect(after.sessions['research-a'].layout).toEqual(before.sessions['research-a'].layout);
    expect(after.conversations[primaryId].anchor).toEqual(before.conversations[primaryId].anchor);
    expect(after.cards).toEqual(before.cards); expect(after.requests).toEqual(before.requests);
    await shot(page, `renamed-discussion-${mode}-1440`); previous = title;
  }
  fixture.assertClean();
});

test('原文旁问答可就地改名，原文位置、回答与未发草稿刷新后保持', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('主会话的独立草稿');
  await selectPassage(page); await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('需要核查这段的条件');
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect(inline(page)).toContainText('受控局部回答');
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('就地未发送输入'); await saved(page);
  const before = await readData(page), conversation = Object.values(before.conversations).find(item => item.inlineSource)!;
  await inline(page).getByRole('button', { name: /^重命名会话：/ }).click();
  await saveName(page, '原文证据核对');
  await expect(inline(page).getByRole('button', { name: '移动原文旁问答', exact: true })).toContainText('原文证据核对');
  const after = await readData(page);
  expect(after.conversations[conversation.id]).toEqual({ ...before.conversations[conversation.id], title: '原文证据核对', titleEdited: true });
  expect(after.requests).toEqual(before.requests); expect(after.evidence).toEqual(before.evidence);
  expect(after.sessions['research-a'].activeConversationId).toBe(primaryId);
  await expect(composer(page)).toHaveValue('主会话的独立草稿');
  await shot(page, 'renamed-inline-1440');
  await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
  await saved(page); await page.reload(); await openSeedPaper(page);
  await main(page).getByRole('button', { name: '上次提问', exact: true }).click();
  await expect(inline(page).getByRole('button', { name: '移动原文旁问答', exact: true })).toContainText('原文证据核对');
  await expect(inline(page)).toContainText('受控局部回答');
  await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('就地未发送输入');
  fixture.assertClean();
});

test('经典历史中的会话使用相同改名弹窗，不切换会话或消费草稿', async ({ page }) => {
  const seed = controlledSeed(); seed.agentWorkbench = false;
  seed.sessions['research-a'].panel = { ...seed.sessions['research-a'].panel, open: true, mode: 'ai', aiView: 'history' };
  seed.conversations[primaryId].input = '经典历史保留的输入';
  const fixture = await installControlledServices(page, { seed });
  await page.goto('/'); await saved(page);
  const panel = page.getByRole('complementary', { name: '参考面板', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '重命名会话：条件比较 A', exact: true }).click();
  const before = await readData(page);
  await saveName(page, '经典阅读讨论');
  await panel.getByRole('searchbox', { name: '搜索会话', exact: true }).fill('经典阅读讨论');
  await expect(panel.locator('.ai-history-item')).toHaveCount(1);
  await expect(panel.locator('.ai-history-item')).toContainText('经典阅读讨论');
  const after = await readData(page);
  expect(after.conversations[primaryId]).toEqual({ ...before.conversations[primaryId], title: '经典阅读讨论', titleEdited: true });
  expect(after.sessions['research-a'].activeConversationId).toBe(before.sessions['research-a'].activeConversationId);
  expect(after.requests).toEqual(before.requests);
  await shot(page, 'renamed-classic-history-1440');
  fixture.assertClean();
});
