import { openResearchPage } from './knowledge-helpers';
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';

const main = (page: Page) => page.getByRole('main', { name: '主工作区' });
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const answer = '这项结论依赖证据与研究问题的相关性，需要保留原文中的适用条件。 [1]\n\n核查时应对照实验设置、语料范围和限制，区分论文依据与自己的推断。\n\n同屏阅读原文和解释，可以发现解释中省略的前提，并把待核查之处留在独立草稿中。';
const pendingInput = '这是一条尚未发送、需要继续完善的问题';
const writing = '尚未完成的研究结论：核对原文后继续写作。';

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const journal = localStorage.getItem('papertrail-recovery-v3');
    if (journal) return JSON.parse(journal);
    const modulePath = '/src/data/storage.ts';
    return (await import(modulePath)).loadWorkspace();
  });
}
async function originalInMain(page: Page) {
  await expect(main(page).getByRole('region', { name: 'PDF 阅读器 主区' })).toBeVisible();
  await expect(main(page).getByRole('spinbutton').first()).toHaveValue('3');
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await expect(main(page).locator('canvas')).toBeVisible();
  await expect(panel(page).getByRole('tab', { name: 'AI', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('region', { name: /PDF 阅读器/ })).toHaveCount(0);
  expect((await state(page)).sessions['research-a'].anchor?.evidenceId).toBe('evidence-a');
}
async function backToWriting(page: Page) {
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await expect(main(page).getByLabel('结论正文')).toHaveValue(writing);
}
async function setup(page: Page) {
  await page.route('**/api/ai/config', route => route.fulfill({ json: {
    configured: true, model: 'source-layout-test', provider: '确定性测试', images: true, mode: 'live',
    limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 },
  } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/chat', route => {
    const request = route.request().postDataJSON();
    const text = request.purpose === 'chat' ? answer : JSON.stringify({ title: '适用条件需要核查', body: '证据需要与适用条件一起保留。 [1]', evidenceIds: ['evidence-a'] });
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'delta', text }) + '\n' + JSON.stringify({ type: 'done', model: 'source-layout-test' }) + '\n' });
  });
  await page.goto('/');
  await expect.poll(async () => (await state(page))?.documents['paper-a']?.title).toBeTruthy();
  const title = (await state(page)).documents['paper-a'].title;
  await main(page).getByRole('button', { name: new RegExp(title) }).click();
  await expect(main(page).locator('canvas')).toBeVisible();
  await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0);
  await panel(page).getByRole('tab', { name: '摘录', exact: true }).click();
  await panel(page).locator('[data-evidence-id="evidence-a"]').getByRole('button', { name: '加入 AI', exact: true }).click();
  await page.getByRole('button', { name: '主区返回', exact: true }).click();
  await openResearchPage(page, '检索增强的适用条件');
  await main(page).getByLabel('结论正文').fill(writing);
  for (const question of ['先解释这条材料的适用条件', '进一步核查推断与论文依据']) {
    await panel(page).getByLabel('向 AI 提问').fill(question);
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
  }
  await panel(page).getByLabel('向 AI 提问').fill(pendingInput);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`AI 引用在中央打开，回答、材料、草稿和相关对话留在右侧 ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    const turn = panel(page).locator('.ai-turn').last();
    const citation = turn.getByRole('button', { name: /^引用 1：/ });
    await citation.scrollIntoViewIfNeeded();
    const chat = panel(page).getByRole('log', { name: '对话消息' });
    const scrollTop = await chat.evaluate(element => element.scrollTop);
    await citation.click();
    await originalInMain(page);
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
    await expect(turn.locator('.ai-answer')).toContainText('这项结论依赖证据');
    expect(await chat.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
    const documentBounds = (await main(page).locator('canvas').boundingBox())!;
    const panelBounds = (await panel(page).boundingBox())!;
    expect(documentBounds.x + documentBounds.width).toBeLessThanOrEqual(panelBounds.x + 1);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await mkdir('docs/verification/agents', { recursive: true });
    await page.screenshot({ path: `docs/verification/agents/reference-main-${viewport.width}.png` });
    await backToWriting(page);

    await turn.locator('.ai-turn-range > summary').click();
    await turn.locator('.ai-turn-range > .ai-context-details').getByRole('button', { name: '查看原文', exact: true }).click();
    await originalInMain(page);
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
    await expect(turn.locator('.ai-turn-range')).toHaveAttribute('open', '');
    await backToWriting(page);

    await turn.getByRole('button', { name: '整理为卡片', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '生成卡片草稿', exact: true }).click();
    const editor = panel(page).getByRole('region', { name: 'AI 卡片草稿' });
    await expect(editor.getByLabel('卡片正文')).toBeEnabled();
    await editor.getByLabel('卡片标题').fill('保留的独立草稿标题');
    await editor.getByLabel('卡片正文').fill('尚未确认加入卡片的手写内容。 [1]');
    await editor.getByRole('button', { name: /论文依据 \[1\]/ }).click();
    await originalInMain(page);
    await expect(editor.getByLabel('卡片标题')).toHaveValue('保留的独立草稿标题');
    await expect(editor.getByLabel('卡片正文')).toHaveValue('尚未确认加入卡片的手写内容。 [1]');
    expect((await state(page)).sessions['research-a'].panel.aiView).toBe('draft');
    await backToWriting(page);

    await editor.getByRole('button', { name: /相关对话/ }).click();
    const source = panel(page).locator('.ai-source-view');
    await source.locator('.ai-answer-sources .ai-citation').click();
    await originalInMain(page);
    await expect(source.getByRole('heading', { name: '相关对话', exact: true })).toBeVisible();
    await expect(source).toContainText('进一步核查推断与论文依据');
    expect((await state(page)).sessions['research-a'].panel.aiView).toBe('source');
    await backToWriting(page);
    await source.getByRole('button', { name: '返回来源入口', exact: true }).click();
    await expect(editor.getByLabel('卡片正文')).toHaveValue('尚未确认加入卡片的手写内容。 [1]');
    await editor.getByRole('button', { name: '返回对话并保留草稿', exact: true }).click();
    await expect(panel(page).getByLabel('向 AI 提问')).toHaveValue(pendingInput);
  });
}
