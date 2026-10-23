import { expect, test } from '@playwright/test';
import { chat, composer, inline, installControlledServices, main, ndjson, openSeedPaper, primaryId, readData, readDrawing, saved, screenshot, secondaryId, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';
import { openResearchNavigation } from './knowledge-helpers';
import { groups, layout, pane, panes, split } from './workspace-split-helpers';

test.use({ storageState: { cookies: [], origins: [] } });

test('资源中发送即清空并直接显示回答；紧凑会话切换保留 PDF 和独立草稿', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  const initial = await readData(page);
  const originalLayout = initial.sessions['research-a'].layout;
  await composer(page).fill('在这篇论文旁说明需要核对的检索条件。');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(chat(page).getByText('受控研究回答 1：先对齐检索条件，再核查相关性。回答在当前会话完整保留。', { exact: true })).toBeVisible();
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  expect(fixture.researchCalls).toHaveLength(1);
  const data = await readData(page);
  expect(data.requests[fixture.researchCalls[0].requestId].conversationId).toBe(primaryId);
  expect(data.sessions['research-a'].layout).toEqual(originalLayout);
  await composer(page).fill('A 的下一轮草稿');
  const navigation = await openResearchNavigation(page);
  const list = navigation.getByRole('region', { name: '研究会话列表', exact: true });
  await list.getByRole('button', { name: '打开会话：补查证据 B', exact: true }).click();
  await expect(composer(page)).toHaveValue('另一个会话的私有草稿');
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  await list.getByRole('button', { name: '打开会话：条件比较 A', exact: true }).click();
  await expect(composer(page)).toHaveValue('A 的下一轮草稿');
  expect((await readData(page)).sessions['research-a'].layout).toEqual(originalLayout);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(composer(page)).toBeInViewport({ ratio: 1 });
    await expect(chat(page).getByRole('button', { name: '开始研究', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, `resource-chat-${width}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const compactRow = list.getByRole('button', { name: '打开会话：补查证据 B', exact: true });
  expect((await compactRow.boundingBox())!.height).toBeLessThanOrEqual(44);
  await saved(page); await page.reload(); await openSeedPaper(page);
  await expect(composer(page)).toHaveValue('A 的下一轮草稿');
  expect((await readData(page)).conversations[secondaryId].input).toBe('另一个会话的私有草稿');
  fixture.assertClean();
});

test('侧边聊天可拖动分隔条调宽，宽度刷新后保留，主区不被挤没', async ({ page }) => {
  await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  const handle = chat(page).getByRole('separator', { name: '调整聊天宽度', exact: true });
  const before = (await chat(page).boundingBox())!, grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 200); await page.mouse.down();
  await page.mouse.move(grip.x - 150, grip.y + 200, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => Math.round((await chat(page).boundingBox())!.width)).toBeGreaterThan(before.width + 120);
  await page.mouse.move(grip.x - 150, grip.y + 200); await page.mouse.down();
  await page.mouse.move(5, grip.y + 200, { steps: 8 }); await page.mouse.up();
  expect((await main(page).boundingBox())!.width).toBeGreaterThanOrEqual(355);
  await saved(page); const width = (await readData(page)).panelWidth;
  await page.reload(); await expect(composer(page)).toBeVisible();
  expect(Math.round((await chat(page).boundingBox())!.width)).toBe(width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('同一会话侧边、浮窗、完整显示连续移动；资源分屏、请求和草稿不复制', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await split(page, pane(page, 1), '右');
  const before = await layout(page);
  expect(groups(before.root)).toHaveLength(2);
  await composer(page).fill('换位置时保留的输入草稿');
  await chat(page).getByRole('button', { name: '浮窗聊天', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'float');
  await expect(composer(page)).toHaveCount(1);
  await expect(composer(page)).toHaveValue('换位置时保留的输入草稿');
  await expect(panes(page)).toHaveCount(2);
  await screenshot(page, 'same-conversation-floating-1440.png');
  await chat(page).getByRole('button', { name: '展开聊天', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'main');
  await expect(composer(page)).toHaveValue('换位置时保留的输入草稿');
  expect(await layout(page)).toEqual(before);
  await chat(page).getByRole('button', { name: '侧边聊天', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'side');
  await expect(panes(page)).toHaveCount(2);
  expect(await layout(page)).toEqual(before);
  const after = await readData(page);
  expect(after.sessions['research-a'].activeConversationId).toBe(primaryId);
  expect(Object.values(after.conversations).filter(conversation => conversation.researchId === 'research-a')).toHaveLength(2);
  expect(after.conversations[primaryId].requestIds).toEqual([]);
  await saved(page); await page.reload();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'side');
  await expect(composer(page)).toHaveValue('换位置时保留的输入草稿');
  expect(await layout(page)).toEqual(before);
  fixture.assertClean();
});

test('完整聊天后重进同一白板列表可见；关闭聊天后围绕白板追问会打开输入', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  const navigation = await openResearchNavigation(page);
  await navigation.locator('.agent-browse > summary').click();
  await navigation.getByRole('button', { name: '白板', exact: true }).click();
  await expect(main(page).getByRole('button', { name: '证据与论证', exact: true })).toBeVisible();
  await chat(page).getByRole('button', { name: '展开聊天', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'main');
  await navigation.getByRole('button', { name: '白板', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'side');
  await main(page).getByRole('button', { name: '证据与论证', exact: true }).click();
  await expect(main(page).locator('.board-viewport')).toBeVisible();
  await chat(page).getByRole('button', { name: '关闭聊天', exact: true }).click();
  await expect(chat(page)).toHaveCount(0);
  await page.getByRole('button', { name: '围绕这里追问', exact: true }).click();
  await expect(chat(page)).toHaveAttribute('data-chat-mode', 'side');
  await expect(composer(page)).toBeVisible();
  const data = await readData(page);
  expect(data.sessions['research-a'].active).toEqual({ kind: 'board', id: 'board-a' });
  expect(data.conversations[primaryId].researchFocus?.ref).toEqual({ kind: 'board', id: 'board-a' });
  expect(fixture.researchCalls).toHaveLength(0);
  fixture.assertClean();
});

test('卡片与摘录以浮窗编辑和按本篇筛选，定位原文后保留聊天与修改', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('查看卡片时保留的聊天草稿');
  await page.getByRole('button', { name: '卡片与摘录', exact: true }).click();
  const notes = page.getByRole('dialog', { name: '卡片与摘录', exact: true });
  await expect(notes).toBeVisible();
  await notes.getByRole('button', { name: '编辑卡片：相关性是检索收益的前提', exact: true }).click();
  const body = '这次人工编辑必须保留。检索收益仍需原文依据，不由 AI 自动覆盖。';
  await notes.getByLabel('卡片正文', { exact: true }).fill(body);
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  await expect(composer(page)).toHaveValue('查看卡片时保留的聊天草稿');
  await screenshot(page, 'card-editor-over-source-1440.png');
  await notes.getByRole('button', { name: '返回卡片与摘录', exact: true }).click();
  await notes.getByRole('button', { name: /^本篇：/ }).click();
  await notes.getByRole('tab', { name: /^摘录/ }).click();
  const data = await readData(page);
  const documentEvidence = Object.values(data.evidence).filter(evidence => !evidence.contextOnly && evidence.documentId === 'paper-a');
  for (const evidence of documentEvidence) await expect(notes.locator(`[data-evidence-id="${evidence.id}"]`)).toBeVisible();
  const other = Object.values(data.evidence).find(evidence => evidence.documentId !== 'paper-a');
  if (other) await expect(notes.locator(`[data-evidence-id="${other.id}"]`)).toHaveCount(0);
  await notes.getByRole('button', { name: '定位原文', exact: true }).first().click();
  await expect(notes).toBeHidden();
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  await expect(composer(page)).toHaveValue('查看卡片时保留的聊天草稿');
  await saved(page); await page.reload();
  await expect(main(page).locator('.pdf-reader')).toBeVisible();
  expect((await readData(page)).cards['card-a'].body).toBe(body);
  await expect(composer(page)).toHaveValue('查看卡片时保留的聊天草稿');
  fixture.assertClean();
});

test('切换文字助手保留同会话历史、草稿与图片；不支持的附件阻止提交，语音入口说明范围', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('先保留一轮研究回答。');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(chat(page)).toContainText('受控研究回答 1');
  await composer(page).fill('切换助手也要保留这条未发送草稿');
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 70;
    canvas.getContext('2d')!.fillRect(0, 0, 120, 70);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await chat(page).getByLabel('选择图片文件', { exact: true }).setInputFiles({ name: 'continuous-selection.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
  await expect(chat(page).getByRole('region', { name: '待发送图片', exact: true })).toBeVisible();
  const before = await readData(page);
  await chat(page).getByRole('button', { name: '选择研究助手', exact: true }).click();
  await chat(page).getByRole('option', { name: 'Claude Code', exact: true }).click();
  const ordinaryInput = chat(page).getByRole('textbox', { name: '向 AI 提问', exact: true });
  await expect(ordinaryInput).toHaveValue('切换助手也要保留这条未发送草稿');
  await expect(chat(page)).toContainText('受控研究回答 1');
  await expect(chat(page).getByRole('region', { name: '待发送图片', exact: true })).toBeVisible();
  await expect(chat(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled();
  await expect(chat(page)).toContainText('草稿已保留');
  const after = await readData(page);
  expect(after.sessions['research-a'].activeConversationId).toBe(primaryId);
  expect(Object.keys(after.conversations)).toEqual(Object.keys(before.conversations));
  expect(after.conversations[primaryId].requestIds).toEqual(before.conversations[primaryId].requestIds);
  expect(after.conversations[primaryId].chatImages).toEqual(before.conversations[primaryId].chatImages);
  expect(fixture.localCalls).toHaveLength(0); expect(fixture.researchCalls).toHaveLength(1);
  await chat(page).getByRole('button', { name: '语音输入', exact: true }).click();
  await expect(chat(page)).toContainText('识别文字留在草稿，不自动发送');
  await chat(page).getByRole('button', { name: '关闭语音输入说明', exact: true }).click();
  await screenshot(page, 'assistant-switch-retains-image-and-history.png');
  await chat(page).getByRole('button', { name: '移除图片：continuous-selection.png', exact: true }).click();
  await expect(chat(page).getByRole('region', { name: '待发送图片', exact: true })).toHaveCount(0);
  await expect(ordinaryInput).toHaveValue('切换助手也要保留这条未发送草稿');
  fixture.assertClean();
});

test('真实 PDF 文字选区三动作分开；翻译和摘要卡片可从原位记录找回', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('主会话未发送草稿，不应进入局部请求');
  await selectPassage(page);
  for (const name of ['提问', '翻译', '摘要卡片']) await expect(selectionMenu(page).getByRole('button', { name, exact: true })).toBeVisible();
  expect(fixture.localCalls).toHaveLength(0);
  await selectionMenu(page).getByRole('button', { name: '翻译', exact: true }).click();
  await expect(inline(page, '翻译')).toContainText('受控翻译');
  await expect(composer(page)).toHaveValue('主会话未发送草稿，不应进入局部请求');
  await screenshot(page, 'translation-on-source-1440.png');
  await inline(page, '翻译').getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  await selectPassage(page);
  await selectionMenu(page).getByRole('button', { name: '摘要卡片', exact: true }).click();
  await expect(inline(page, '摘要卡片')).toContainText('受控摘要');
  await expect(inline(page, '摘要卡片').getByLabel('就地卡片正文')).toHaveValue(/受控摘要/);
  await inline(page, '摘要卡片').getByLabel('就地卡片标题').fill('连续工作区摘要卡片');
  await inline(page, '摘要卡片').getByRole('button', { name: '保存卡片', exact: true }).click();
  await expect(inline(page, '摘要卡片')).toContainText('已加入当前研究的卡片');
  await inline(page, '摘要卡片').getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  const data = await readData(page);
  const local = Object.values(data.conversations).filter(conversation => conversation.inlineSource);
  expect(new Set(local.map(conversation => conversation.id)).size).toBeGreaterThanOrEqual(2);
  expect(local.some(conversation => conversation.inlineSource?.operation === 'translation')).toBe(true);
  expect(local.some(conversation => conversation.inlineSource?.operation === 'summary')).toBe(true);
  const card = Object.values(data.cards).find(card => card.title === '连续工作区摘要卡片')!;
  expect(card).toBeTruthy(); expect(card.evidenceIds.length).toBeGreaterThan(0);
  expect(data.conversations[primaryId].requestIds).toEqual([]);
  expect(JSON.stringify(fixture.localCalls)).not.toContain('主会话未发送草稿');
  await saved(page); await page.reload(); await openSeedPaper(page);
  await page.getByRole('button', { name: /^查看此处记录 · / }).first().click();
  const activities = page.getByLabel('此处操作记录', { exact: true });
  await expect(activities).toContainText('翻译'); await expect(activities).toContainText('摘要卡片');
  await activities.getByRole('button', { name: /摘要卡片/ }).first().click();
  await expect(inline(page, '摘要卡片')).toContainText('受控摘要');
  expect(Object.values((await readData(page)).cards).filter(item => item.title === card.title)).toHaveLength(1);
  fixture.assertClean();
});

test('两个原文位置独立问答，共用本篇文章简要；简要与原文证据分开并刷新恢复', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('主会话秘密草稿，不可混入文章简要或局部问题');
  for (const [text, prompt] of [
    ['This self-authored fixture describes', '第一处问题：这里为何区分两种检索？'],
    ['When does adding a retrieval stage', '第二处问题：这里的回答质量如何判断？'],
  ]) {
    await selectPassage(page, text);
    await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
    await inline(page).getByLabel('向原文旁助手提问').fill(prompt);
    await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
    await expect(inline(page)).toContainText('受控局部回答');
    await inline(page).locator('.inline-ai-brief > summary').click();
    await expect(inline(page).locator('.inline-ai-brief')).toContainText('仅作背景，引用仍以原文选区为准');
    await expect(inline(page).locator('.inline-ai-brief')).toContainText('覆盖 3/3 页');
    await inline(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  }
  const data = await readData(page), brief = data.documents['paper-a'].paperBrief!;
  expect(brief.status).toBe('ready'); expect(brief.pageIndices).toEqual([0, 1, 2]); expect(brief.totalPages).toBe(3);
  expect(brief.documentHash).toBe(data.documents['paper-a'].hash);
  const conversations = Object.values(data.conversations).filter(conversation => conversation.inlineSource?.operation === 'question');
  expect(conversations).toHaveLength(2);
  expect(new Set(conversations.map(conversation => conversation.inlineSource!.evidenceId)).size).toBe(2);
  expect(conversations.every(conversation => conversation.paperBrief?.key === brief.key)).toBe(true);
  const requests = conversations.map(conversation => data.requests[conversation.requestIds[0]]);
  expect(requests.every(request => request.paperBrief?.key === brief.key && request.context.length === 1 && request.evidenceIds.length === 1)).toBe(true);
  expect(requests.every(request => request.materials?.some(material => material.kind === 'background' && material.title === '文章简要（AI 背景）'))).toBe(true);
  expect(requests[0].evidenceIds).not.toEqual(requests[1].evidenceIds);
  const briefs = fixture.localCalls.filter(call => call.purpose === 'card');
  expect(briefs).toHaveLength(1); expect(briefs[0].context).toEqual([]); expect(briefs[0].history).toEqual([]);
  expect(JSON.stringify(fixture.localCalls)).not.toContain('主会话秘密草稿');
  await screenshot(page, 'shared-brief-independent-source-questions.png');
  await saved(page); await page.reload(); await openSeedPaper(page);
  const restored = await readData(page);
  expect(restored.documents['paper-a'].paperBrief).toEqual(brief);
  for (const conversation of conversations) expect(restored.conversations[conversation.id]).toEqual(conversation);
  await expect(composer(page)).toHaveValue('主会话秘密草稿，不可混入文章简要或局部问题');
  fixture.assertClean();
});

test('实际区域框选带局部 PNG 提问，原文和图片范围保持；原位记录可找回', async ({ page }) => {
  const fixture = await installControlledServices(page);
  await page.goto('/'); await openSeedPaper(page);
  await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
  const layer = main(page).getByLabel('拖动框选当前 PDF 页区域', { exact: true }).first();
  await expect(layer).toBeVisible();
  const bounds = (await layer.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .12, bounds.y + bounds.height * .08); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .68, bounds.y + bounds.height * .24, { steps: 15 }); await page.mouse.up();
  await expect(selectionMenu(page)).toBeVisible();
  await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  await inline(page).getByLabel('向原文旁助手提问').fill('解释这块选中区域，不能假装读取未选内容。');
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  await expect(inline(page)).toContainText('受控局部回答');
  const data = await readData(page);
  const request = Object.values(data.requests).find(request => request.readerOperation === 'question')!;
  expect(request.context).toHaveLength(1);
  expect(request.context[0]).toMatchObject({ documentId: 'paper-a', pageIndex: 0, kind: 'region' });
  expect(request.context[0].region!.rect.width).toBeCloseTo(.56, 2);
  expect(request.context[0].region!.rect.height).toBeCloseTo(.16, 2);
  const sent = fixture.localCalls.find(call => call.purpose === 'chat')!;
  const images = sent.images as { evidenceId: string; dataUrl: string }[];
  expect(images).toHaveLength(1); expect(images[0].evidenceId).toBe(request.context[0].evidenceId);
  expect(images[0].dataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    await expect(inline(page).getByLabel('向原文旁助手提问')).toBeInViewport({ ratio: 1 });
    const rect = (await inline(page).boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(0); expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    await screenshot(page, `region-question-${width}.png`);
  }
  await inline(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  await saved(page); await page.reload(); await openSeedPaper(page);
  await page.locator('.pdf-region-activity-marker').first().click();
  await page.getByLabel('此处操作记录', { exact: true }).getByRole('button', { name: /提问/ }).first().click();
  await expect(inline(page)).toContainText('受控局部回答');
  expect((await readData(page)).requests[request.id].context).toEqual(request.context);
  fixture.assertClean();
});

test('原有 Excalidraw 绘图、人工箭头和资料收录在连续工作区仍可用', async ({ page }) => {
  const fixture = await installControlledServices(page);
  const candidate = { id: 'openalex-continuous', provider: 'openalex', providerId: 'W1234567', title: 'Controlled Continuous Research', authors: ['Fixture Author'], year: 2024, doi: '10.1234/continuous', url: 'https://doi.org/10.1234/continuous', abstract: 'Source metadata only, not original PDF evidence.', retrievedAt: '2026-10-23T00:00:00Z' };
  await page.route('**/api/ai/research/run', route => {
    fixture.researchCalls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([
      { type: 'literature', search: { id: 'continuous-literature', query: 'retrieval conditions', status: 'done', createdAt: '2026-10-23T00:00:00Z', candidates: [candidate] } },
      { type: 'delta', text: '找到一项可收录的受控文献题录。' }, { type: 'done', model: 'controlled-continuous', readPages: [] },
    ]) });
  });
  await page.route('**/api/sources/resolve', route => route.fulfill({ json: { title: candidate.title, url: candidate.url, kind: 'paper', identifiers: { doi: candidate.doi }, warning: '合成题录，无 PDF 全文。' } }));
  await page.route('**/api/sources/pdf', route => route.fulfill({ status: 404, json: { error: '合成题录没有 PDF' } }));
  await page.goto('/'); await openSeedPaper(page);
  await composer(page).fill('找一份可加入资料库的文献。');
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  const results = chat(page).getByRole('region', { name: /文献检索/ });
  await expect(results).toContainText(candidate.title);
  await results.getByRole('button', { name: '加入本研究', exact: true }).click();
  await expect.poll(async () => Object.values((await readData(page)).documents).filter(document => document.title === candidate.title).length).toBe(1);
  const navigation = await openResearchNavigation(page);
  await navigation.locator('.agent-browse > summary').click();
  await navigation.getByRole('button', { name: '白板', exact: true }).click();
  await main(page).getByRole('button', { name: '证据与论证', exact: true }).click();
  await main(page).getByRole('button', { name: '绘图', exact: true }).click();
  const drawing = main(page).getByLabel('白板自由绘图', { exact: true }), canvas = drawing.locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const bounds = (await canvas.boundingBox())!;
  await drawing.getByTestId('toolbar-rectangle').locator('..').click();
  await page.mouse.move(bounds.x + 230, bounds.y + bounds.height * .6); await page.mouse.down();
  await page.mouse.move(bounds.x + 370, bounds.y + bounds.height * .6 + 60, { steps: 10 }); await page.mouse.up();
  await drawing.getByTestId('toolbar-arrow').locator('..').click();
  await page.mouse.move(bounds.x + 250, bounds.y + bounds.height * .6 + 90); await page.mouse.down();
  await page.mouse.move(bounds.x + 390, bounds.y + bounds.height * .6 + 120, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await readData(page)).boards['board-a'].drawing?.hash).toMatch(/^[a-f0-9]{64}$/);
  await expect.poll(async () => (await readDrawing(page))?.elements.filter(element => !element.isDeleted && !element.customData?.boardRelation && element.type === 'arrow').length).toBe(1);
  expect((await readDrawing(page))?.elements.some(element => !element.isDeleted && element.type === 'rectangle')).toBe(true);
  await saved(page);
  const before = await readData(page);
  const drawingBefore = await readDrawing(page);
  await screenshot(page, 'existing-drawing-and-chat-1440.png');
  await page.reload(); await expect(canvas).toBeVisible();
  expect((await readData(page)).boards['board-a'].drawing).toEqual(before.boards['board-a'].drawing);
  expect(await readDrawing(page)).toEqual(drawingBefore);
  expect(Object.values((await readData(page)).documents).filter(document => document.title === candidate.title)).toHaveLength(1);
  fixture.assertClean();
});
