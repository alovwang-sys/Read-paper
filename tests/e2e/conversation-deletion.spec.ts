import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { chat, composer, controlledSeed, installControlledServices, main, ndjson, openSeedPaper, primaryId, readData, saved, secondaryId } from '../../docs/verification/continuous-workspace/harness';
import { openResearchNavigation, switchResearch } from './knowledge-helpers';

test.use({ storageState: { cookies: [], origins: [] } });
const confirmation = (page: Page) => page.getByRole('alertdialog', { name: '删除会话', exact: true });
const deleted = (page: Page) => page.getByRole('dialog', { name: '已删除会话', exact: true });
const list = async (page: Page) => (await openResearchNavigation(page)).getByRole('region', { name: '研究会话列表', exact: true });
async function shot(page: Page, name: string) {
  await mkdir('docs/verification/conversation-deletion/screenshots', { recursive: true });
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/conversation-deletion/screenshots/${name}.png` });
}

test('侧栏与标题均可删除当前会话；恢复原历史和草稿，资源保持，刷新不复活', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('会话删除验收：核对检索条件');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(chat(page)).toContainText('受控研究回答 1');
  await composer(page).fill('删除后仍需保留的未发送草稿'); await saved(page);
  const before = await readData(page), title = before.conversations[primaryId].title!;
  const navigation = await list(page);
  await navigation.getByRole('button', { name: `删除会话：${title}`, exact: true }).click();
  await expect(confirmation(page)).toBeVisible();
  await confirmation(page).getByRole('button', { name: '取消', exact: true }).click();
  expect((await readData(page)).conversations[primaryId].deletedAt).toBeUndefined();
  await navigation.getByRole('button', { name: `删除会话：${title}`, exact: true }).click();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(confirmation(page).getByRole('button', { name: '确认删除', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `delete-confirm-${width}`);
  }
  await confirmation(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(composer(page)).toHaveValue('另一个会话的私有草稿');
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  await saved(page);
  const removed = await readData(page);
  expect(removed.conversations[primaryId].deletedAt).toBeTruthy();
  expect(removed.conversations[primaryId].input).toBe(before.conversations[primaryId].input);
  expect(removed.requests).toEqual(before.requests);
  expect(removed.sessions['research-a'].layout).toEqual(before.sessions['research-a'].layout);
  expect(removed.sessions['research-a'].activeConversationId).toBe(secondaryId);
  await (await list(page)).getByRole('button', { name: '已删除会话', exact: true }).click();
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(deleted(page).getByRole('button', { name: `恢复会话：${title}`, exact: true })).toBeInViewport({ ratio: 1 });
    await shot(page, `deleted-list-${width}`);
  }
  await deleted(page).getByRole('button', { name: `恢复会话：${title}`, exact: true }).click();
  await expect(deleted(page)).toContainText('会话已恢复');
  await deleted(page).getByRole('button', { name: '关闭已删除会话', exact: true }).click();
  await (await list(page)).getByRole('button', { name: `打开会话：${title}`, exact: true }).click();
  await expect(composer(page)).toHaveValue(before.conversations[primaryId].input!);
  await expect(chat(page)).toContainText('受控研究回答 1');
  await page.setViewportSize({ width: 1440, height: 900 });
  await chat(page).getByRole('button', { name: `删除会话：${title}`, exact: true }).click();
  await confirmation(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await saved(page); await page.reload(); await openSeedPaper(page);
  await expect(composer(page)).toHaveValue('另一个会话的私有草稿');
  await expect((await list(page)).getByRole('button', { name: `打开会话：${title}`, exact: true })).toHaveCount(0);
  await (await list(page)).getByRole('button', { name: '已删除会话', exact: true }).click();
  await expect(deleted(page).getByRole('button', { name: `恢复会话：${title}`, exact: true })).toBeVisible();
  expect((await readData(page)).requests).toEqual(before.requests);
  expect(fixture.researchCalls).toHaveLength(1); fixture.assertClean();
});

test('已删除列表严格按研究隔离，恢复另一个研究不会恢复原研究', async ({ page }) => {
  const seed = controlledSeed();
  seed.conversations['conversation-research-b'].title = '另一研究的已删除会话';
  seed.conversations['conversation-research-b'].deletedAt = '2026-10-23T00:00:00Z';
  seed.conversations['conversation-research-b'].archived = true;
  const fixture = await installControlledServices(page, { seed });
  await page.goto('/'); await openSeedPaper(page);
  await chat(page).getByRole('button', { name: '删除会话：条件比较 A', exact: true }).click();
  await confirmation(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await (await list(page)).getByRole('button', { name: '已删除会话', exact: true }).click();
  await expect(deleted(page).getByRole('button', { name: '恢复会话：条件比较 A', exact: true })).toBeVisible();
  await expect(deleted(page).getByRole('button', { name: '恢复会话：另一研究的已删除会话', exact: true })).toHaveCount(0);
  await deleted(page).getByRole('button', { name: '关闭已删除会话', exact: true }).click();
  await switchResearch(page, 'research-b');
  await (await list(page)).getByRole('button', { name: '已删除会话', exact: true }).click();
  await expect(deleted(page).getByRole('button', { name: '恢复会话：条件比较 A', exact: true })).toHaveCount(0);
  await deleted(page).getByRole('button', { name: '恢复会话：另一研究的已删除会话', exact: true }).click();
  await saved(page);
  const after = await readData(page);
  expect(after.conversations[primaryId].deletedAt).toBeTruthy();
  expect(after.conversations['conversation-research-b'].deletedAt).toBeUndefined();
  fixture.assertClean();
});

test('请求仍在进行时确认删除显示原因，保留会话与草稿', async ({ page }) => {
  const fixture = await installControlledServices(page);
  let finish!: () => Promise<void>;
  await page.route('**/api/ai/research/run', route => new Promise<void>(resolve => {
    finish = async () => { await route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([{ type: 'delta', text: '受控延迟回答' }, { type: 'done', model: 'controlled-continuous', readPages: [] }]) }); resolve(); };
  }));
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('等待受控请求返回');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect.poll(() => !!finish).toBe(true);
  await composer(page).fill('任务进行中也应保留的草稿');
  await chat(page).getByRole('button', { name: '删除会话：条件比较 A', exact: true }).click();
  await confirmation(page).getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(confirmation(page).getByRole('alert')).toContainText('任务进行中');
  await shot(page, 'delete-busy-rejected');
  await confirmation(page).getByRole('button', { name: '取消', exact: true }).click();
  await expect(composer(page)).toHaveValue('任务进行中也应保留的草稿');
  expect((await readData(page)).conversations[primaryId].deletedAt).toBeUndefined();
  expect((await readData(page)).sessions['research-a'].activeConversationId).toBe(primaryId);
  await finish(); await expect(chat(page)).toContainText('受控延迟回答');
  fixture.assertClean();
});
