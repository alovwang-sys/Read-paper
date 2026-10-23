# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: inline-ai.spec.ts >> 选区旁解释、追问、存卡与刷新保持右侧独立 1440
- Location: tests/e2e/inline-ai.spec.ts:43:3

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByLabel('原文选区操作').getByRole('button', { name: '解释这段', exact: true })

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e3]:
    - complementary "左侧导航" [ref=e4]:
      - generic [ref=e5]:
        - strong [ref=e9]: Papertrail
        - button "收起左栏" [ref=e10] [cursor=pointer]
      - generic [ref=e14]:
        - button "切换研究" [ref=e16] [cursor=pointer]:
          - generic [ref=e20]: 检索增强，何时有效？
        - button "项目设置 · 检索增强，何时有效？" [ref=e23] [cursor=pointer]
      - generic [ref=e28]:
        - button "新建研究" [ref=e29] [cursor=pointer]
        - button "全局搜索" [ref=e31] [cursor=pointer]
      - navigation "研究内导航" [ref=e35]:
        - button "研究主页" [ref=e37] [cursor=pointer]
        - generic [ref=e41]:
          - generic [ref=e42]: 阅读
          - button "资料" [ref=e43] [cursor=pointer]
        - button "摘录" [ref=e47] [cursor=pointer]
        - generic [ref=e51]:
          - generic [ref=e52]: 思考与写作
          - button "卡片" [ref=e53] [cursor=pointer]
        - generic [ref=e58]:
          - generic [ref=e59]:
            - button "白板" [ref=e60] [cursor=pointer]
            - button "收起白板列表" [expanded] [ref=e67] [cursor=pointer]
          - generic [ref=e70]:
            - generic [ref=e71]:
              - button "证据与论证" [ref=e72] [cursor=pointer]
              - button "证据与论证 的排序操作" [ref=e79]
            - generic [ref=e87]:
              - button "条件与限制" [ref=e88] [cursor=pointer]
              - button "条件与限制 的排序操作" [ref=e95]
        - generic [ref=e103]:
          - generic [ref=e104]:
            - button "文稿" [ref=e105] [cursor=pointer]
            - button "收起文稿列表" [expanded] [ref=e110] [cursor=pointer]
          - generic [ref=e114]:
            - button "检索增强的适用条件" [ref=e115] [cursor=pointer]
            - button "检索增强的适用条件 的排序操作" [ref=e120]
      - generic [ref=e128]:
        - button "Agent 工作台" [ref=e129] [cursor=pointer]
        - button "全局资料库" [ref=e134] [cursor=pointer]
        - button "设置" [ref=e137] [cursor=pointer]
      - generic [ref=e141]:
        - generic [ref=e143]: 已保存到本地
        - button "存储与设置" [ref=e144] [cursor=pointer]
      - separator "调整左侧宽度" [ref=e148]
    - generic [ref=e149]:
      - banner [ref=e150]:
        - generic [ref=e151]:
          - button "主区返回" [ref=e152] [cursor=pointer]
          - generic [ref=e155]: 检索增强，何时有效？
          - strong [ref=e158]: "Adaptive Retrieval: Evidence & Reliability"
        - generic [ref=e159]:
          - button "文献信息" [ref=e160] [cursor=pointer]
          - generic [ref=e161]: 已保存
          - button "添加资料" [ref=e164] [cursor=pointer]
          - button "收起右侧面板" [ref=e166] [cursor=pointer]
      - main "主工作区" [ref=e171]:
        - region "中央窗格工作区" [ref=e172]:
          - region "工作区窗格 1" [ref=e175]:
            - generic [ref=e176]:
              - tablist "窗格 1 标签" [ref=e177]:
                - generic [ref=e178]:
                  - tab "研究主页" [ref=e179]
                  - button "关闭标签 研究主页" [ref=e184] [cursor=pointer]
                - generic [ref=e188]:
                  - 'tab "Adaptive Retrieval: Evidence & Reliability" [selected] [ref=e189]'
                  - 'button "关闭标签 Adaptive Retrieval: Evidence & Reliability" [ref=e193] [cursor=pointer]'
              - button "窗格 1 操作" [ref=e197] [cursor=pointer]:
                - generic [ref=e200]: 分屏
              - button "放大窗格 1" [disabled] [ref=e201]
            - region "PDF 阅读器" [ref=e208]:
              - generic [ref=e209]:
                - button "目录与全文搜索" [ref=e210] [cursor=pointer]
                - group "PDF 选择方式" [ref=e212]:
                  - button "文字选择" [pressed] [ref=e213] [cursor=pointer]
                  - button "区域框选" [ref=e217] [cursor=pointer]
                - generic [ref=e223]:
                  - button "上一页" [disabled] [ref=e224]
                  - generic [ref=e227]:
                    - spinbutton "PDF 页码" [ref=e228]: "1"
                    - generic [ref=e229]: / 3
                  - button "下一页" [ref=e230] [cursor=pointer]
                - generic [ref=e233]:
                  - button "缩小 PDF" [ref=e234] [cursor=pointer]
                  - button "100%" [ref=e236] [cursor=pointer]
                  - button "放大 PDF" [ref=e237] [cursor=pointer]
                - group "阅读状态" [ref=e239]:
                  - button "略读过" [ref=e240] [cursor=pointer]
                  - button "读完" [ref=e241] [cursor=pointer]
              - generic [ref=e242]:
                - generic [ref=e243]: 阅读就绪
                - generic [ref=e244]: 文本已就绪 · 可选择原文
              - generic "连续滚动阅读区域" [active] [ref=e245]:
                - generic [ref=e246]:
                  - generic [ref=e247]:
                    - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 1 页" [ref=e248]'
                    - generic [ref=e249]: READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 1 Abstract This self-authored fixture describes an imaginary comparison between a fixed retrieval baseline and an adaptive evidence selection method. Its purpose is to exercise reading, text selection, citation navigation, and research notes in the Read-paper workbench. All methods, data, and results are synthetic. They must not be used as claims about a real system or publication. The document includes ordinary selectable text and stable page boundaries for reproducible product tests. 1. Research question When does adding a retrieval stage improve the factual quality of an answer? We compare answers grounded in a relevant evidence collection with answers grounded in a collection containing unrelated material. A useful comparison records the question, the available sources, the selected evidence, and the resulting answer. The answer can then be checked against the same source excerpts that were available at generation time. 2. Evidence collection The imaginary corpus contains short notes about a single research question. Each note has an identifier, a page number, and an excerpt. We retain these fields together because a quote without its source cannot support a reviewable conclusion.
                    - generic "原文操作标记"
                  - generic [ref=e250]:
                    - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 2 页" [ref=e251]'
                    - generic [ref=e252]: READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 2 3. Synthetic procedure The fixed baseline always selects two notes. The adaptive method first checks whether a candidate note is relevant to the question, then chooses up to two relevant notes. Both methods receive the same synthetic corpus and the same answer length limit. A reviewer marks each statement as supported, contradicted, or absent from the selected notes. Supported statements are counted only when the source excerpt can be recovered by its document identifier and PDF page index. 4. Imaginary results In the relevant-corpus condition, the adaptive method produces more supported statements. In the unrelated-corpus condition, selecting additional notes does not create useful evidence. These are invented observations for software verification. Relevance is a condition of the example, not a universal property of retrieval. The test deliberately preserves this qualification so that cards and conclusions can represent both the claim and its limits. 5. Reproducibility notes A reliable answer should preserve a traceable link to its supporting evidence. The fixture generator fixes metadata dates, typography, page size, and content. Re-running the generator should create the same bytes. The paper uses a single text column and three PDF pages. Text extraction and rendering are separate capabilities. This fixture has a text layer, while the accompanying scanned research note contains a raster image and no selectable page text.
                    - generic "原文操作标记":
                      - button "查看此处记录 · 1条" [ref=e253] [cursor=pointer]: "1"
                  - generic [ref=e254]:
                    - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 3 页" [ref=e255]'
                    - generic [ref=e256]: "READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 3 6. Main finding Retrieval improves factual accuracy when the evidence corpus is relevant. This exact sentence is the selection target for the end-to-end research workflow. It is intentionally located on PDF page 3, whose internal page index is 2. It should remain selectable after zooming or reopening the document. 7. Conditions and limits The finding is conditional on source relevance and recoverable citations. A fluent answer may still contain unsupported details. Reviewers should inspect the original excerpt rather than treating the presence of a citation as proof of correctness. The fixture makes no claim about real benchmark performance. It exists to demonstrate evidence cards, shared card reuse, board organization, and a conclusion export that includes bibliography details, PDF page numbers, and quotations. 8. Conclusion A research note is easier to verify when its claims preserve the conditions under which they were observed. Explicit source excerpts let the reader revisit the same evidence while writing a conclusion. Suggested synthetic citation: Read-paper fixture authors (2026). Adaptive Retrieval for Evidence-Grounded Answers. Self-authored software test material; not a real publication."
                    - generic "原文操作标记":
                      - button "查看此处记录 · 1条" [ref=e257] [cursor=pointer]: "1"
              - generic [ref=e258]:
                - generic [ref=e259]: adaptive-retrieval.pdf
                - generic [ref=e260]: PDF 第 1 页 · 100%
    - complementary "参考面板" [ref=e261]:
      - separator "调整右侧宽度" [ref=e262]
      - generic [ref=e263]:
        - tablist "参考面板模式" [ref=e264]:
          - tab "摘录" [ref=e265] [cursor=pointer]
          - tab "卡片" [ref=e266] [cursor=pointer]
          - tab "AI" [selected] [ref=e267] [cursor=pointer]
        - generic [ref=e271]:
          - button "右侧返回" [disabled] [ref=e272]
          - button "固定右侧参考" [ref=e275] [cursor=pointer]
          - button "关闭右侧面板" [ref=e278] [cursor=pointer]
      - region "AI 阅读对话" [ref=e283]:
        - generic [ref=e284]:
          - heading "阅读对话" [level=3] [ref=e288]
          - generic "glm-5.3-flash · 真实模型" [ref=e289]:
            - status [ref=e290]:
              - generic [ref=e291]: glm-5.3-flash · 真实模型
            - button "切换 AI 助手" [ref=e293] [cursor=pointer]:
              - generic [ref=e297]: 模型直连
          - button "查看会话历史" [ref=e300] [cursor=pointer]
          - button "新建干净对话" [ref=e305] [cursor=pointer]
        - log "对话消息" [ref=e308]:
          - generic [ref=e309]:
            - heading "新对话" [level=3] [ref=e310]
            - paragraph [ref=e311]: 输入问题，或选择原文后加入材料。
            - paragraph [ref=e312]: 也可以直接说：“把这些观点画成关系图”。生成的白板会留在聊天中，随时打开或撤销。
        - status [ref=e313]
        - generic [ref=e314]:
          - generic [ref=e315]:
            - group [ref=e316]:
              - generic "▸ 本轮材料 · 0" [ref=e317] [cursor=pointer]:
                - text: ▸
                - generic [ref=e318]: 本轮材料 · 0
            - group [ref=e319]:
              - generic "对话范围 · 0 轮" [ref=e320] [cursor=pointer]
              - option "本会话全部" [selected]
              - option "最近 1 轮"
              - option "不含前序对话"
            - group [ref=e321]:
              - generic "白板工具" [ref=e322] [cursor=pointer]
              - option "选择目标白板…" [selected]
              - option "证据与论证"
              - option "条件与限制"
          - generic [ref=e323]:
            - textbox "向 AI 提问" [ref=e324]:
              - /placeholder: 基于这些材料提问，或继续追问…
              - text: 右侧保留的未发送输入
            - generic [ref=e325]:
              - button "添加材料" [ref=e326] [cursor=pointer]
              - generic [ref=e328]:
                - button "语音输入" [ref=e330] [cursor=pointer]:
                  - generic [ref=e334]: 语音
                - button "发送问题" [ref=e335] [cursor=pointer]
          - paragraph [ref=e338]: ⌘ / Ctrl + Enter 发送 · 只发送显式材料及所选历史，不自动发送整篇论文。
  - generic "原文选区操作" [ref=e339]:
    - generic [ref=e340]:
      - generic [ref=e341]: PDF 第 1 页 · 102 字符
      - group [ref=e342]:
        - generic "查看所选原文" [ref=e343] [cursor=pointer]
    - generic [ref=e344]:
      - button "提问" [ref=e345] [cursor=pointer]
      - button "翻译" [ref=e348] [cursor=pointer]
      - button "摘要卡片" [ref=e353] [cursor=pointer]
      - group [ref=e358]:
        - generic "更多操作" [ref=e359] [cursor=pointer]: •••
      - button "取消原文选区" [ref=e360] [cursor=pointer]
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import { mkdir } from 'node:fs/promises';
  3   | import type { WorkspaceData } from '../../src/domain/types';
  4   | 
  5   | const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
  6   | const dialog = (page: Page) => page.getByRole('dialog', { name: '原文旁提问' });
  7   | const state = (page: Page): Promise<WorkspaceData> => page.evaluate(async () => { const journal = localStorage.getItem('papertrail-recovery-v3'); if (journal) return JSON.parse(journal); const path = '/src/data/storage.ts'; return (await import(path)).loadWorkspace(); });
  8   | 
  9   | async function start(page: Page, failure = false) {
  10  |   let calls = 0, nativeCalls = 0;
  11  |   await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: true, runtime: 'pi', model: 'glm-5.3-flash', provider: '测试', images: true, mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  12  |   await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  13  |   await page.route('**/api/ai/agents/run', route => { nativeCalls++; return route.fulfill({ status: 502, json: { error: '本机 Agent 连接失败，请检查 CLI 配置后重试。' } }); });
  14  |   await page.route('**/api/ai/chat', async route => {
  15  |     calls++;
  16  |     if (failure && calls === 1) return route.fulfill({ status: 429, contentType: 'application/x-ndjson', body: '{"type":"error","error":"模型额度或并发受限，请稍后手动重试。"}\n' });
  17  |     const messages = route.request().postDataJSON().messages;
  18  |     expect(messages.at(-1).content).toBeTruthy();
  19  |     expect(JSON.stringify(messages)).not.toContain('右侧保留的未发送输入');
  20  |     const body = calls === 1 ? '这段是在比较固定检索与自适应选证据的方法。关键在于证据是否与问题相关。 [1]' : '这里的“相关”指证据能支持当前问题，不能只看是否检索到了更多材料。 [1]';
  21  |     return route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'delta', text: body }) + '\n' + JSON.stringify({ type: 'done', model: 'glm-5.3-flash' }) + '\n' });
  22  |   });
  23  |   await page.goto('/');
  24  |   await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  25  |   const paper = (await state(page)).documents['paper-a'];
  26  |   await page.getByRole('main', { name: '主工作区' }).getByRole('button', { name: paper.title, exact: true }).first().click();
  27  |   await expect(page.locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first()).toBeVisible();
  28  |   await expect.poll(async () => (await state(page)).documents['paper-a'].hash).toMatch(/^[a-f0-9]{64}$/);
  29  |   return { calls: () => calls, nativeCalls: () => nativeCalls };
  30  | }
  31  | 
  32  | async function selectPassage(page: Page) {
  33  |   const span = page.locator('.pdf-text-layer span').filter({ hasText: 'This self-authored fixture describes' }).first();
  34  |   const bounds = (await span.boundingBox())!;
  35  |   await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2);
  36  |   await page.mouse.down();
  37  |   await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 12 });
  38  |   await page.mouse.up();
  39  |   await expect(page.getByLabel('原文选区操作', { exact: true })).toBeVisible();
  40  | }
  41  | 
  42  | for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  43  |   test(`选区旁解释、追问、存卡与刷新保持右侧独立 ${size.width}`, async ({ page }) => {
  44  |     await page.setViewportSize(size);
  45  |     const requests = await start(page);
  46  |     await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  47  |     await panel(page).getByLabel('向 AI 提问', { exact: true }).fill('右侧保留的未发送输入');
  48  |     const before = await state(page), rightId = before.sessions['research-a'].activeConversationId!;
  49  |     await selectPassage(page);
  50  |     expect(requests.calls()).toBe(0);
> 51  |     await page.getByLabel('原文选区操作').getByRole('button', { name: '解释这段', exact: true }).click();
      |                                                                                        ^ Error: locator.click: Test timeout of 60000ms exceeded.
  52  |     await expect(dialog(page)).toContainText('这段是在比较固定检索');
  53  |     await dialog(page).getByRole('button', { name: '[1]', exact: true }).click();
  54  |     await expect(dialog(page)).toBeVisible();
  55  |     const bounds = (await dialog(page).boundingBox())!;
  56  |     expect(bounds.x).toBeGreaterThanOrEqual(0);
  57  |     expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
  58  |     expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
  59  |     await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue('右侧保留的未发送输入');
  60  |     await dialog(page).getByLabel('向原文旁助手提问').fill('这里的相关是什么意思？');
  61  |     await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
  62  |     await expect(dialog(page)).toContainText('这里的“相关”');
  63  |     const after = await state(page), inline = Object.values(after.conversations).find(item => item.inlineSource)!;
  64  |     expect(after.sessions['research-a'].activeConversationId).toBe(rightId);
  65  |     expect(after.conversations[rightId].requestIds).toEqual(before.conversations[rightId].requestIds);
  66  |     expect(after.evidence[inline.inlineSource!.evidenceId].contextOnly).toBe(true);
  67  |     expect(requests.nativeCalls()).toBe(0);
  68  |     await mkdir('docs/verification/ai-fixes-017', { recursive: true });
  69  |     await page.screenshot({ path: `docs/verification/ai-fixes-017/answer-${size.width}.png`, fullPage: true });
  70  |     await dialog(page).getByRole('button', { name: '收为卡片', exact: true }).click();
  71  |     await dialog(page).getByLabel('就地卡片标题').fill('相关证据的含义');
  72  |     await dialog(page).getByRole('button', { name: '保存卡片', exact: true }).click();
  73  |     await expect(dialog(page)).toContainText('已加入当前研究的卡片');
  74  |     await dialog(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  75  |     await expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
  76  |     await page.reload();
  77  |     await page.getByRole('button', { name: '上次提问', exact: true }).click();
  78  |     await expect(dialog(page)).toContainText('这里的“相关”');
  79  |     await expect(panel(page).getByLabel('向 AI 提问', { exact: true })).toHaveValue('右侧保留的未发送输入');
  80  |     await dialog(page).getByRole('button', { name: '在右侧继续', exact: true }).click();
  81  |     await expect(dialog(page)).toHaveCount(0);
  82  |     await expect(panel(page)).toContainText('这里的“相关”');
  83  |     const continued = await state(page);
  84  |     expect(continued.sessions['research-a'].activeConversationId).toBe(inline.id);
  85  |     expect(continued.conversations[rightId].input).toBe('右侧保留的未发送输入');
  86  |     expect(Object.values(continued.cards).some(card => card.title === '相关证据的含义' && card.provenance?.conversationId === inline.id)).toBe(true);
  87  |   });
  88  | }
  89  | 
  90  | test('手动提问不自动发送，模型报错后就地重试且保留问题', async ({ page }) => {
  91  |   const requests = await start(page, true);
  92  |   await selectPassage(page);
  93  |   await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  94  |   expect(requests.calls()).toBe(0);
  95  |   await dialog(page).getByLabel('向原文旁助手提问').fill('这个概念是什么？');
  96  |   await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
  97  |   await expect(dialog(page).getByRole('alert')).toContainText('模型额度或并发受限');
  98  |   await expect(dialog(page).getByLabel('向原文旁助手提问')).toHaveValue('这个概念是什么？');
  99  |   await dialog(page).getByRole('button', { name: '重试', exact: true }).click();
  100 |   await expect(dialog(page)).toContainText('这里的“相关”');
  101 |   expect(requests.nativeCalls()).toBe(0);
  102 | });
  103 | 
  104 | 
  105 | test('停止等待中的回答保留问题，关闭后仍能恢复继续', async ({ page }) => {
  106 |   await start(page);
  107 |   let finish!: () => void;
  108 |   await page.route('**/api/ai/chat', async route => {
  109 |     await new Promise<void>(resolve => { finish = resolve; });
  110 |     await route.fulfill({ contentType: 'application/x-ndjson', body: '{"type":"done"}\n' }).catch(() => {});
  111 |   });
  112 |   await selectPassage(page);
  113 |   await page.getByLabel('原文选区操作').getByRole('button', { name: '提问', exact: true }).click();
  114 |   await dialog(page).getByLabel('向原文旁助手提问').fill('请解释这个概念');
  115 |   await dialog(page).getByRole('button', { name: '发送就地问题' }).click();
  116 |   await expect.poll(() => !!finish).toBe(true);
  117 |   await dialog(page).getByRole('button', { name: '停止就地回答' }).click();
  118 |   finish();
  119 |   await expect(dialog(page)).toContainText('已停止');
  120 |   await expect(dialog(page)).toContainText('请解释这个概念');
  121 |   await expect(dialog(page).getByRole('button', { name: '重试', exact: true })).toBeVisible();
  122 |   await dialog(page).getByLabel('向原文旁助手提问').fill('等我补充一个问题');
  123 |   await dialog(page).getByRole('button', { name: '关闭就地问答并保留内容' }).click();
  124 |   await page.getByRole('button', { name: '上次提问', exact: true }).click();
  125 |   await expect(dialog(page).getByLabel('向原文旁助手提问')).toHaveValue('等我补充一个问题');
  126 |   expect(Object.values((await state(page)).requests).at(-1)?.status).toBe('stopped');
  127 | });
  128 | 
  129 | for (const size of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 800 }]) {
  130 |   test(`原文旁问答支持拖动、缩放和键盘操作 ${size.width}`, async ({ page }) => {
  131 |     await page.setViewportSize(size);
  132 |     const requests = await start(page);
  133 |     await selectPassage(page);
  134 |     await page.getByLabel('原文选区操作').getByRole('button', { name: '解释这段', exact: true }).click();
  135 |     await expect(dialog(page)).toContainText('这段是在比较固定检索');
  136 |     const floating = page.locator('.reader-popover.inline-ai');
  137 |     const move = dialog(page).getByRole('button', { name: '移动原文旁问答', exact: true });
  138 |     const resize = floating.getByRole('button', { name: '调整原文旁问答大小', exact: true });
  139 |     const initial = (await floating.boundingBox())!;
  140 |     const title = (await move.boundingBox())!;
  141 |     await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
  142 |     await page.mouse.down();
  143 |     await page.mouse.move(65, 175, { steps: 12 });
  144 |     await page.mouse.up();
  145 |     const moved = (await floating.boundingBox())!;
  146 |     expect(moved.x).toBeLessThan(initial.x - 50);
  147 |     expect(moved.y).not.toBe(initial.y);
  148 |     expect(moved.width).toBeCloseTo(initial.width);
  149 |     const grip = (await resize.boundingBox())!;
  150 |     await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  151 |     await page.mouse.down();
```