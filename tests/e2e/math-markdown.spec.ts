import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { chat, inline, installControlledServices, main, ndjson, openSeedPaper, readData, saved, selectPassage, selectionMenu } from '../../docs/verification/continuous-workspace/harness';

test.use({ storageState: { cookies: [], origins: [] } });
const reply = [
  '### 重要性比与 GRPO 策略比',
  String.raw`重要性比为 \(r_{i,t}(\theta)=\frac{\pi_\theta(o_{i,t}\mid q,o_{i,<t})}{\pi_{\theta_{\mathrm{old}}}(o_{i,t}\mid q,o_{i,<t})}\)。它对比新旧策略在同一条件下的概率。`,
  String.raw`设组大小 $G=8$；数组索引 \(x_{[0]}+x_{[99]}\) 中的方括号不是文献引用。`,
  '普通括号 (这一段只是一句解释) 不应被推断为公式。',
  String.raw`\[`,
  String.raw`\mathcal{J}_{\mathrm{GRPO}}(\theta)=\mathbb{E}\!\left[\frac{1}{G}\sum_{i=1}^{G}\frac{1}{|o_i|}\sum_{t=1}^{|o_i|}\min\!\left(r_{i,t}(\theta)\widehat A_{i,t},\operatorname{clip}(r_{i,t}(\theta),1-\epsilon,1+\epsilon)\widehat A_{i,t}\right)-\beta D_{\mathrm{KL}}(\pi_\theta\Vert\pi_{\mathrm{ref}})\right]`,
  String.raw`\]`,
  '$$',
  String.raw`\widehat A_i=\frac{R_i-\operatorname{mean}(R)}{\operatorname{std}(R)+\epsilon}`,
  '$$',
  '以上是排版验收用的合成公式说明；本处只引用所选样例原文定位。[1]',
  '行内代码保持原样：`' + String.raw`\(b_{[99]}\)` + '`。',
  '```tex',
  String.raw`\(x_{[0]}\)`,
  String.raw`\[a_{[99]}\]`,
  '```',
  '![受控远程图片](https://math-fixture.invalid/tracker.png)',
  '<img src="https://math-fixture.invalid/raw-html.png" onerror="window.mathHtmlExecuted=true">',
].join('\n\n');

async function assertMath(answer: Locator) {
  await expect(answer.locator('.katex')).toHaveCount(5);
  await expect(answer.locator('.katex-display')).toHaveCount(2);
  await expect(answer.locator('.katex-error')).toHaveCount(0);
  await expect(answer.locator('annotation[encoding="application/x-tex"]').filter({ hasText: String.raw`\frac{\pi_\theta` })).toHaveCount(1);
  await expect(answer.getByText('普通括号 (这一段只是一句解释) 不应被推断为公式。', { exact: true })).toBeVisible();
  await expect(answer.locator('p').filter({ hasText: '普通括号' }).locator('.katex')).toHaveCount(0);
  await expect(answer.locator('pre code')).toHaveText(String.raw`\(x_{[0]}\)` + '\n\n' + String.raw`\[a_{[99]}\]`);
  await expect(answer.locator('pre .katex, code .katex')).toHaveCount(0);
  await expect(answer.locator('p > code')).toHaveText(String.raw`\(b_{[99]}\)`);
  await expect(answer.locator('img, iframe, script')).toHaveCount(0);
}
async function shot(page: Page, name: string) {
  await mkdir('docs/verification/math-markdown/screenshots', { recursive: true });
  await saved(page); await expect(main(page).locator('.pdf-page-loading')).toHaveCount(0); await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/verification/math-markdown/screenshots/${name}.png` });
}

test('原文旁与侧边会话渲染两类TeX括号和美元公式，代码/引用/原始正文均保持', async ({ page }) => {
  const fixture = await installControlledServices(page), sent: { purpose: string }[] = [], remoteRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('math-fixture.invalid')) remoteRequests.push(request.url()); });
  await page.route('https://math-fixture.invalid/**', route => route.abort());
  for (const endpoint of ['chat', 'agents/run']) await page.route(`**/api/ai/${endpoint}`, route => {
    const payload = route.request().postDataJSON(); sent.push(payload);
    return route.fulfill({ contentType: 'application/x-ndjson', body: ndjson([{ type: 'delta', text: payload.purpose === 'brief' ? '受控本篇背景：内容为合成材料，不提供额外证据。' : reply }, { type: 'done', model: 'math-fixture' }]) });
  });
  await page.goto('/'); await openSeedPaper(page); await selectPassage(page);
  await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('请解释重要性比与 GRPO 的策略比，并保留数学排版。');
  await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  const localAnswer = inline(page).locator('.inline-ai-turn .ai-markdown').first();
  await expect(localAnswer).toContainText('重要性比与 GRPO'); await assertMath(localAnswer);
  await expect(localAnswer.getByRole('button', { name: '[1]', exact: true })).toHaveCount(1);
  await expect(localAnswer.getByRole('button', { name: '[0]', exact: true })).toHaveCount(0);
  await expect(localAnswer.getByRole('button', { name: '[99]', exact: true })).toHaveCount(0);
  const data = await readData(page), request = Object.values(data.requests).find(item => item.readerOperation === 'question')!;
  expect(request.status).toBe('done'); expect(request.body).toBe(reply); expect(request.rawBody).toBe(reply);
  expect(request.evidenceIds).toEqual([request.context[0].evidenceId]);
  await localAnswer.getByRole('button', { name: '[1]', exact: true }).click();
  await expect(main(page).locator(`.pdf-source-highlight[data-evidence-id="${request.context[0].evidenceId}"]`).first()).toBeVisible();
  if (!await inline(page).isVisible()) await main(page).getByRole('button', { name: '上次提问', exact: true }).click();
  await assertMath(localAnswer);
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    const block = localAnswer.locator('.katex-display').first();
    await block.scrollIntoViewIfNeeded();
    const overflow = await block.evaluate(element => { const node = element as HTMLElement; return { scroll: node.scrollWidth, client: node.clientWidth, mode: getComputedStyle(node).overflowX }; });
    expect(overflow.scroll).toBeGreaterThan(overflow.client); expect(overflow.mode).toBe('auto');
    await block.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    expect(await block.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await block.evaluate(element => { element.scrollLeft = 0; });
    const bounds = (await inline(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toBeInViewport({ ratio: 1 });
    await shot(page, `inline-formulas-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await inline(page).getByRole('button', { name: '在右侧继续', exact: true }).click();
  const sideAnswer = chat(page).locator(`.ai-turn[data-request-id="${request.id}"] .ai-markdown`).first();
  await assertMath(sideAnswer);
  expect((await readData(page)).sessions['research-a'].activeConversationId).toBe(request.conversationId);
  await sideAnswer.locator('.katex-display').first().scrollIntoViewIfNeeded();
  await shot(page, 'side-formulas-1440');
  await saved(page); await page.reload();
  await assertMath(sideAnswer);
  const restored = await readData(page);
  expect(restored.requests[request.id].body).toBe(reply); expect(restored.requests[request.id].rawBody).toBe(reply);
  expect(restored.sessions['research-a'].activeConversationId).toBe(request.conversationId);
  expect(sent.map(call => call.purpose)).toEqual(['brief', 'chat']); expect(remoteRequests).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { mathHtmlExecuted?: boolean }).mathHtmlExecuted)).toBeUndefined();
  fixture.assertClean();
});
