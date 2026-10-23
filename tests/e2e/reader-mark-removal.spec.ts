import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { chat, composer, inline, installControlledServices, main, openSeedPaper, readData, saved, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';

test.use({ storageState: { cookies: [], origins: [] } });
async function shot(page: Page, name: string) {
  await mkdir('docs/verification/conversation-deletion/screenshots', { recursive: true });
  await saved(page); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/conversation-deletion/screenshots/${name}.png` });
}

for (const kind of ['文字', '区域'] as const) test(`${kind}提问后可直接移除标记、撤销和刷新恢复，问答及引用保留`, async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('主会话草稿，与原文问答分离');
  if (kind === '文字') await selectPassage(page);
  else {
    await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
    const layer = main(page).getByLabel('拖动框选当前 PDF 页区域').first();
    const rect = (await layer.boundingBox())!;
    await page.mouse.move(rect.x + rect.width * .12, rect.y + rect.height * .08); await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * .68, rect.y + rect.height * .24, { steps: 10 }); await page.mouse.up();
  }
  await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill(`关于这段${kind}的提问`);
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect(inline(page)).toContainText('受控局部回答');
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('原文局部的未发送草稿');
  await saved(page);
  const before = await readData(page), conversation = Object.values(before.conversations).find(item => item.inlineSource)!;
  const evidenceId = conversation.inlineSource!.evidenceId;
  const marker = () => main(page).locator(kind === '文字' ? `.pdf-activity-marker[data-evidence-id="${evidenceId}"]` : '.pdf-region-activity-marker');
  await expect(marker()).toHaveCount(1);
  await inline(page).getByRole('button', { name: '移除标记', exact: true }).click();
  await expect(inline(page)).toBeVisible();
  await expect(marker()).toHaveCount(0);
  await expect(page.getByText('已移除原文标记，内容与引用保留', { exact: true })).toBeVisible();
  await saved(page);
  const hidden = await readData(page);
  expect(hidden.evidence[evidenceId]).toEqual({ ...before.evidence[evidenceId], annotationHidden: true });
  expect(hidden.conversations[conversation.id]).toEqual(before.conversations[conversation.id]);
  expect(hidden.requests).toEqual(before.requests); expect(hidden.cards).toEqual(before.cards);
  await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('原文局部的未发送草稿');
  for (const [width, height] of kind === '文字' ? [[1440, 900], [1280, 800], [1024, 800]] : [[1440, 900]]) {
    await page.setViewportSize({ width, height });
    await expect(inline(page).getByRole('button', { name: '恢复标记', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `mark-hidden-${kind === '文字' ? 'text' : 'region'}-${width}`);
  }
  await page.getByRole('button', { name: '撤销移除', exact: true }).click();
  await expect(marker()).toHaveCount(1);
  await inline(page).getByRole('button', { name: '移除标记', exact: true }).click();
  await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
  await saved(page); await page.reload(); await openSeedPaper(page);
  await expect(marker()).toHaveCount(0);
  expect((await readData(page)).evidence[evidenceId].annotationHidden).toBe(true);
  await main(page).getByRole('button', { name: '上次提问', exact: true }).click();
  await expect(inline(page)).toContainText('受控局部回答');
  await inline(page).getByRole('button', { name: '恢复标记', exact: true }).click();
  await expect(marker()).toHaveCount(1); await saved(page);
  const restored = await readData(page);
  expect(restored.evidence[evidenceId].annotationHidden).toBeUndefined();
  expect(restored.evidence[evidenceId].contextOnly).toBe(true);
  expect(restored.requests).toEqual(before.requests);
  expect(restored.conversations[conversation.id].input).toBe('原文局部的未发送草稿');
  await expect(composer(page)).toHaveValue('主会话草稿，与原文问答分离');

  if (kind === '文字') {
    await page.setViewportSize({ width: 1440, height: 900 });
    await inline(page).getByRole('button', { name: '在右侧继续', exact: true }).click();
    const title = (await readData(page)).conversations[conversation.id].title!;
    await chat(page).getByRole('button', { name: `删除会话：${title}`, exact: true }).click();
    await page.getByRole('alertdialog', { name: '删除会话', exact: true }).getByRole('button', { name: '确认删除', exact: true }).click();
    await marker().click();
    await page.getByLabel('此处操作记录', { exact: true }).getByRole('button', { name: /提问/ }).first().click();
    await expect(inline(page)).toContainText('会话已删除，此处记录仅供查看');
    await expect(inline(page).getByRole('button', { name: '发送就地问题', exact: true })).toHaveCount(0);
    await expect(inline(page)).toContainText('原文局部的未发送草稿');
    await saved(page);
    expect((await readData(page)).conversations[conversation.id].deletedAt).toBeTruthy();
    const calls = fixture.localCalls.length;
    await shot(page, 'deleted-inline-readonly-1440');
    await inline(page).getByRole('button', { name: '恢复会话', exact: true }).click();
    await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('原文局部的未发送草稿');
    await saved(page);
    expect((await readData(page)).conversations[conversation.id].deletedAt).toBeUndefined();
    expect(fixture.localCalls.length).toBe(calls);
  }
  fixture.assertClean();
});
