import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { createSeed } from '../../src/data/seed';
import type { WorkspaceData } from '../../src/domain/types';
import { mockProjectService } from './project-fixture';
import { openResearchPage, openSource } from './knowledge-helpers';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问', { exact: true });
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
const state = (page: Page): Promise<WorkspaceData> => page.evaluate(async () => {
  const journal = localStorage.getItem('papertrail-recovery-v3');
  const path = '/src/data/storage.ts';
  return journal ? JSON.parse(journal) : (await import(path)).loadWorkspace();
});

async function start(page: Page) {
  const seed = createSeed();
  for (const conversation of Object.values(seed.conversations)) conversation.connectionId = 'codex';
  await mockProjectService(page, { seed });
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'fixture', mode: 'live' } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
  await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [], skills: [], plan: false, accessModes: ['read-only'] } }));
  let modelCalls = 0;
  for (const path of ['chat', 'agents/run']) await page.route(`**/api/ai/${path}`, route => {
    modelCalls++;
    return route.fulfill({ status: 500, json: { error: '本用例不应发送模型请求。' } });
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible();
  await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  return () => modelCalls;
}

async function collapseDuringInput(textarea: Locator) {
  // A public, unrelated store update occurs after native input, before React's bubble handler.
  await textarea.evaluate(element => element.addEventListener('input', () => queueMicrotask(() => {
    const button = document.querySelector<HTMLButtonElement>('.sidebar button[aria-label="收起左栏"]');
    if (!button) throw new Error('缺少收起左栏按钮，未触发输入顺序回归条件。');
    button.click();
  }), { once: true }));
}

async function composeWithoutSubmitting(textarea: Locator, text: string) {
  await textarea.evaluate((element, value) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: value, isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', ctrlKey: true, isComposing: true, keyCode: 229 }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: value }));
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value, isComposing: false }));
  }, text);
  await expect(textarea).toHaveValue(text);
}

async function append(textarea: Locator, text: string) {
  await textarea.focus();
  await textarea.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(input.value.length, input.value.length); });
  await textarea.pressSequentially(text);
}

async function screenshots(page: Page, textarea: Locator, name: string) {
  await mkdir('docs/verification/input-retention', { recursive: true });
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 800 });
    await expect(textarea).toBeVisible();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    await page.screenshot({ path: `docs/verification/input-retention/${name}-${width}.png` });
  }
}

test('右侧输入先于无关导航更新保存，继续输入、中文组合和刷新保持一致', async ({ page }) => {
  const modelCalls = await start(page);
  await openResearchPage(page, '检索增强的适用条件');
  const conversationId = (await state(page)).sessions['research-a'].activeConversationId!;
  await collapseDuringInput(input(page));
  const draft = '保留当前问题中的研究条件。';
  await input(page).fill(draft);
  await expect(input(page)).toHaveValue(draft);
  expect((await state(page)).sidebarCollapsed).toBe(true);
  expect((await state(page)).conversations[conversationId].input).toBe(draft);
  await append(input(page), '继续核对来源。');
  const composed = draft + '继续核对来源。中文组合输入也要保留。';
  await composeWithoutSubmitting(input(page), composed);
  await saved(page);
  expect((await state(page)).conversations[conversationId].input).toBe(composed);
  expect((await state(page)).conversations[conversationId].requestIds).toEqual([]);
  expect(modelCalls()).toBe(0);
  await screenshots(page, input(page), 'writing-ai');
  await page.reload();
  await expect(input(page)).toHaveValue(composed);
  await append(input(page), '刷新后继续。');
  await saved(page);
  expect((await state(page)).conversations[conversationId].input).toBe(composed + '刷新后继续。');
  expect(modelCalls()).toBe(0);
});

test('原文小窗输入遇到导航更新仍保存，中文组合不发送且与右侧草稿隔离', async ({ page }) => {
  const modelCalls = await start(page);
  const rightDraft = '右侧独立的未发送草稿。';
  await input(page).fill(rightDraft);
  const rightId = (await state(page)).sessions['research-a'].activeConversationId!;
  await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
  const selected = page.getByRole('main').locator('.pdf-text-layer').getByText('Abstract', { exact: true });
  await expect(selected).toBeVisible();
  await selected.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
  });
  await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '原文旁提问' });
  const inlineInput = dialog.getByLabel('向原文旁助手提问');
  await expect(inlineInput).toBeVisible();
  const inlineId = Object.values((await state(page)).conversations).find(conversation => conversation.inlineSource)!.id;
  await collapseDuringInput(inlineInput);
  const draft = '保留这段原文中的限制条件。';
  await inlineInput.fill(draft);
  await expect(inlineInput).toHaveValue(draft);
  expect((await state(page)).sidebarCollapsed).toBe(true);
  expect((await state(page)).conversations[inlineId].input).toBe(draft);
  await append(inlineInput, '继续补充。');
  const composed = draft + '继续补充。中文组合不应提交。';
  await composeWithoutSubmitting(inlineInput, composed);
  await saved(page);
  expect((await state(page)).conversations[inlineId].input).toBe(composed);
  expect((await state(page)).conversations[inlineId].requestIds).toEqual([]);
  await expect(input(page)).toHaveValue(rightDraft);
  expect(modelCalls()).toBe(0);
  await screenshots(page, inlineInput, 'pdf-inline');
  await page.reload();
  await page.getByRole('button', { name: '上次提问', exact: true }).click();
  await expect(inlineInput).toHaveValue(composed);
  await expect(input(page)).toHaveValue(rightDraft);
  await append(inlineInput, '刷新后继续。');
  await saved(page);
  const restored = await state(page);
  expect(restored.conversations[inlineId].input).toBe(composed + '刷新后继续。');
  expect(restored.conversations[rightId].input).toBe(rightDraft);
  expect(modelCalls()).toBe(0);
});
