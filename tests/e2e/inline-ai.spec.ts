import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { WorkspaceData } from '../../src/domain/types';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const dialog = (page: Page) => page.getByRole('dialog', { name: '原文旁提问' });
const state = (page: Page): Promise<WorkspaceData> => page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v3'); if (journal) return JSON.parse(journal); const path = '/src/data/storage.ts'; return (await import(path)).loadWorkspace(); });

async function start(page: Page, failure = false) {
  let calls = 0, nativeCalls = 0;
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, runtime: 'pi', model: 'glm-5.3-flash', provider: '测试', images: true, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.route('**/api/ai/agents/run', route => { nativeCalls++; return route.fulfill({ status: 502, json: { error: '本机 Agent 连接失败，请检查 CLI 配置后重试。' } }); });
  await page.route('**/api/ai/chat', async route => {
    calls++;
    if (failure && calls === 1) return route.fulfill({ status: 429, contentType: 'application/x-ndjson', body: '{"type":"error","error":"模型额度或并发受限，请稍后手动重试。"}\n' });
    const messages = route.request().postDataJSON().messages;
    expect(messages.at(-1).content).toBeTruthy();
    expect(JSON.stringify(messages)).not.toContain('右侧保留的未发送输入');
    const body = calls === 1 ? '这段是在比较固定检索与自适应选证据的方法。关键在于证据是否与问题相关。 [1]' : '这里的“相关”指证据能支持当前问题，不能只看是否检索到了更多材料。 [1]';
    return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'delta', text: body }) + '\n' + JSON.stringify({ type: 'done', model: 'glm-5.3-flash' }) + '\n' });
  });
  await page.goto('/');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  const paper = (await state(page)).documents['paper-a'];
  await page.getByRole('main', { name: '主工作区' }).getByRole('button', { name: paper.title, exact: true }).first().click();
  await expect(page.locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first()).toBeVisible();
  await expect.poll(async () => (await state(page)).documents['paper-a'].hash).toMatch(/^[a-f0-9]{64}$/);
  return { calls: () => calls, nativeCalls: () => nativeCalls };
}

async function selectPassage(page: Page) {
  const span = page.locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first();
  const bounds = (await span.boundingBox())!;
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.getByLabel('原文选区操作', { exact: true })).toBeVisible();
}

for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  test(`选区旁解释、追问、存卡与刷新保持右侧独立 ${size.width}`, async ({ page }) => {
    await page.setViewportSize(size);
    const requests = await start(page);
    await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await panel(page).getByLabel('向 AI 提问', { exact: true }).fill('右侧保留的未发送输入');
    const before = await state(page), rightId = before.sessions['research-a'].activeConversationId!;
    await selectPassage(page);
    expect(requests.calls()).toBe(0);
    await page.getByLabel('原文选区操作').getByRole('button', { name: '解释这段', exact: true }).click();
    await expect(dialog(page)).toContainText('这段是在比较固定检索');
    await dialog(page).getByRole('button', { name: '[1]', exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    const bounds = (await dialog(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
    await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue('右侧保留的未发送输入');
    await dialog(page).getByLabel('向原文旁助手提问').fill('这里的相关是什么意思？');
    await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
    await expect(dialog(page)).toContainText('这里的“相关”');
    const after = await state(page), inline = Object.values(after.conversations).find(item => item.inlineSource)!;
    expect(after.sessions['research-a'].activeConversationId).toBe(rightId);
    expect(after.conversations[rightId].requestIds).toEqual(before.conversations[rightId].requestIds);
    expect(after.evidence[inline.inlineSource!.evidenceId].contextOnly).toBe(true);
    expect(requests.nativeCalls()).toBe(0);
    await mkdir('docs/verification/inline-ai/screenshots', { recursive: true });
    await page.screenshot({ path: `docs/verification/inline-ai/screenshots/answer-${size.width}.png`, fullPage: true });
    await dialog(page).getByRole('button', { name: '收为卡片', exact: true }).click();
    await dialog(page).getByLabel('就地卡片标题').fill('相关证据的含义');
    await dialog(page).getByRole('button', { name: '保存卡片', exact: true }).click();
    await expect(dialog(page)).toContainText('已加入当前研究的卡片');
    await dialog(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
    await page.reload();
    await page.getByRole('button', { name: '上次提问', exact: true }).click();
    await expect(dialog(page)).toContainText('这里的“相关”');
    await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue('右侧保留的未发送输入');
    await dialog(page).getByRole('button', { name: '在右侧继续', exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(panel(page)).toContainText('这里的“相关”');
    const continued = await state(page);
    expect(continued.sessions['research-a'].activeConversationId).toBe(inline.id);
    expect(continued.conversations[rightId].input).toBe('右侧保留的未发送输入');
    expect(Object.values(continued.cards).some(card => card.title === '相关证据的含义' && card.provenance?.conversationId === inline.id)).toBe(true);
  });
}

test('手动提问不自动发送，模型报错后就地重试且保留问题', async ({ page }) => {
  const requests = await start(page, true);
  await selectPassage(page);
  await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  expect(requests.calls()).toBe(0);
  await dialog(page).getByLabel('向原文旁助手提问').fill('这个概念是什么？');
  await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
  await expect(dialog(page).getByRole('alert')).toContainText('模型额度或并发受限');
  await expect(dialog(page).getByLabel('向原文旁助手提问')).toHaveValue('这个概念是什么？');
  await dialog(page).getByRole('button', { name: '重试', exact: true }).click();
  await expect(dialog(page)).toContainText('这里的“相关”');
  expect(requests.nativeCalls()).toBe(0);
});


test('停止等待中的回答保留问题，关闭后仍能恢复继续', async ({ page }) => {
  await start(page);
  let finish!: () => void;
  await page.route('**/api/ai/chat', async route => {
    await new Promise<void>(resolve => { finish = resolve; });
    await route.fulfill({ contentType: 'application/x-ndjson', body: '{"type":"done"}\n' }).catch(() => {});
  });
  await selectPassage(page);
  await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  await dialog(page).getByLabel('向原文旁助手提问').fill('请解释这个概念');
  await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
  await expect.poll(() => !!finish).toBe(true);
  await dialog(page).getByRole('button', { name: '停止就地回答' }).click();
  finish();
  await expect(dialog(page)).toContainText('已停止');
  await expect(dialog(page)).toContainText('请解释这个概念');
  await expect(dialog(page).getByRole('button', { name: '重试', exact: true })).toBeVisible();
  await dialog(page).getByLabel('向原文旁助手提问').fill('等我补充一个问题');
  await dialog(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  await page.getByRole('button', { name: '上次提问', exact: true }).click();
  await expect(dialog(page).getByLabel('向原文旁助手提问')).toHaveValue('等我补充一个问题');
  expect(Object.values((await state(page)).requests).at(-1)?.status).toBe('stopped');
});
