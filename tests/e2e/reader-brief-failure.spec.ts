import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { ContextSnapshot } from '../../src/domain/types';
import { composer, inline, installControlledServices, main, ndjson, openSeedPaper, readData, saved, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';

test.use({ storageState: { cookies: [], origins: [] } });
const legacyError = '卡片标题、正文或来源格式不正确，请重试。';
type Payload = { purpose: string; context?: ContextSnapshot[]; images?: { evidenceId: string; dataUrl: string }[] };
const answer = (text: string) => [{ type: 'delta', text }, { type: 'done', model: 'brief-failure-fixture' }];
const error = (message: string) => [{ type: 'error', error: message }];
async function services(page: Page, respond: (payload: Payload) => object[] | Promise<object[]>) {
  const fixture = await installControlledServices(page), calls: Payload[] = [];
  await page.route('**/api/ai/agents/stop', route => route.fulfill({ json: { stopped: true } }));
  for (const endpoint of ['chat', 'agents/run']) await page.route(`**/api/ai/${endpoint}`, async route => {
    const payload = route.request().postDataJSON() as Payload; calls.push(payload);
    await route.fulfill({ contentType: 'application/x-ndjson', body: ndjson(await respond(payload)) });
  });
  return { fixture, calls };
}
async function select(page: Page, kind: 'text' | 'region') {
  if (kind === 'text') await selectPassage(page);
  else {
    await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
    const layer = main(page).getByLabel('拖动框选当前 PDF 页区域', { exact: true }).first(), bounds = (await layer.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * .12, bounds.y + bounds.height * .08); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .68, bounds.y + bounds.height * .24, { steps: 15 }); await page.mouse.up();
  }
  await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('解释这个公式的假设，只按我选择的原文回答。');
}
async function shot(page: Page, name: string) {
  await mkdir('docs/verification/reader-brief-failure/screenshots', { recursive: true });
  await saved(page); await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/reader-brief-failure/screenshots/${name}.png` });
}

for (const kind of ['text', 'region'] as const) test(`${kind}真实选区简要报旧卡片格式错误后可见降级，问题只发一次且来源保持`, async ({ page }) => {
  const { fixture, calls } = await services(page, payload => payload.purpose === 'brief' ? error(legacyError) : answer('受控公式解释：假设仅限当前选区，未附送内容仍未知。[1]'));
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('主会话未发送输入，不应混入原文问题');
  await select(page, kind); await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect(inline(page)).toContainText('受控公式解释');
  await expect(inline(page)).toContainText('文章简要暂不可用 · 本轮仅使用选区');
  await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('');
  await expect(composer(page)).toHaveValue('主会话未发送输入，不应混入原文问题');
  expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
  const data = await readData(page), request = Object.values(data.requests).find(item => item.readerOperation === 'question')!;
  expect(request).toMatchObject({ status: 'done', paperBriefState: 'error' });
  expect(request.result).toBeUndefined(); expect(request.paperBrief).toBeUndefined();
  expect(request.context).toHaveLength(1); expect(request.context[0]).toMatchObject({ documentId: 'paper-a', pageIndex: 0 });
  expect(request.context[0].kind ?? 'text').toBe(kind);
  expect(request.materials?.some(item => item.id.startsWith('paper-brief:')) ?? false).toBe(false);
  expect(Object.keys(data.cardDrafts)).toHaveLength(0);
  if (kind === 'region') {
    expect(calls[1].images).toHaveLength(1);
    expect(calls[1].images![0]).toMatchObject({ evidenceId: request.context[0].evidenceId, dataUrl: expect.stringMatching(/^data:image\/png;base64,iVBOR/) });
    expect(request.context[0].region!.rect.width).toBeCloseTo(.56, 2);
    expect(request.context[0].region!.rect.height).toBeCloseTo(.16, 2);
  }
  for (const [width, height] of kind === 'region' ? [[1440, 900], [1280, 800], [1024, 800]] : [[1440, 900]]) {
    await page.setViewportSize({ width, height });
    await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `${kind}-brief-fallback-${width}`);
  }
  await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
  await saved(page); await page.reload(); await openSeedPaper(page);
  await main(page).getByRole('button', { name: '上次提问', exact: true }).click();
  await expect(inline(page)).toContainText('受控公式解释');
  await expect(inline(page)).toContainText('文章简要暂不可用 · 本轮仅使用选区');
  expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
  fixture.assertClean();
});

test('简要与真正问题均失败时输入保留，连续点击重试也只增加一轮真正问题', async ({ page }) => {
  let chats = 0, release!: () => void;
  const { fixture, calls } = await services(page, async payload => {
    if (payload.purpose === 'brief') return error(legacyError);
    if (++chats === 1) return error('受控真正问题暂时失败');
    await new Promise<void>(resolve => { release = resolve; }); return answer('重试后按原始选区回答。[1]');
  });
  await page.goto('/'); await openSeedPaper(page); await select(page, 'text');
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect(inline(page)).toContainText('受控真正问题暂时失败');
  await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('解释这个公式的假设，只按我选择的原文回答。');
  const before = await readData(page), original = Object.values(before.requests).find(item => item.readerOperation === 'question')!;
  await inline(page).getByRole('button', { name: '重试', exact: true }).dblclick();
  await expect.poll(() => !!release).toBe(true); release();
  await expect(inline(page)).toContainText('重试后按原始选区回答');
  expect(calls.filter(call => call.purpose === 'chat')).toHaveLength(2);
  const after = await readData(page), requests = Object.values(after.requests).filter(item => item.readerOperation === 'question');
  expect(requests).toHaveLength(2);
  expect(requests.find(item => item.retryOf === original.id)).toMatchObject({ status: 'done', context: original.context });
  await shot(page, 'retry-retains-original-question'); fixture.assertClean();
});

test('等待简要时停止，迟到失败不能继续发送问题，原输入保留', async ({ page }) => {
  let release!: () => void;
  const { fixture, calls } = await services(page, async payload => {
    if (payload.purpose !== 'brief') return answer('不应出现的回答');
    await new Promise<void>(resolve => { release = resolve; }); return error(legacyError);
  });
  await page.goto('/'); await openSeedPaper(page); await select(page, 'text');
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  await inline(page).getByRole('button', { name: '停止就地回答', exact: true }).click(); release();
  await expect(inline(page)).toContainText('已停止');
  await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('解释这个公式的假设，只按我选择的原文回答。');
  await saved(page);
  expect(calls.map(call => call.purpose)).toEqual(['brief']);
  expect(Object.values((await readData(page)).requests).find(item => item.readerOperation === 'question')?.status).toBe('stopped');
  fixture.assertClean();
});
