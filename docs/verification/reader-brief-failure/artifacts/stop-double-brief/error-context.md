# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: reader-brief-failure.spec.ts >> 等待简要时停止，迟到失败不能继续发送问题，原输入保留
- Location: tests/e2e/reader-brief-failure.spec.ts:97:1

# Error details

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 0
+ Received  + 1

  Array [
    "brief",
+   "brief",
  ]
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
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
        - button "研究工作台" [ref=e36] [cursor=pointer]
        - button "本研究资料" [ref=e40] [cursor=pointer]
        - region "研究会话列表" [ref=e43]:
          - generic [ref=e44]:
            - heading "会话" [level=2] [ref=e45]
            - generic [ref=e46]:
              - button "已删除会话" [ref=e47] [cursor=pointer]
              - button "新建会话" [ref=e51] [cursor=pointer]
          - textbox "搜索会话" [ref=e57]
          - generic [ref=e58]:
            - generic [ref=e59]:
              - button "打开会话：条件比较 A" [ref=e60] [cursor=pointer]:
                - generic "当前会话" [ref=e61]
                - generic [ref=e62]: 条件比较 A
              - button "重命名会话：条件比较 A" [ref=e63] [cursor=pointer]
              - button "删除会话：条件比较 A" [ref=e67] [cursor=pointer]
            - generic [ref=e71]:
              - button "打开会话：补查证据 B" [ref=e72] [cursor=pointer]:
                - generic [ref=e74]: 补查证据 B
              - button "重命名会话：补查证据 B" [ref=e75] [cursor=pointer]
              - button "删除会话：补查证据 B" [ref=e79] [cursor=pointer]
          - group [ref=e83]:
            - generic "讨论（1）" [ref=e84] [cursor=pointer]
        - generic [ref=e85]: 最近打开
        - 'button "Adaptive Retrieval: Evidence & Reliability" [ref=e86] [cursor=pointer]'
        - group [ref=e90]:
          - generic "浏览研究内容" [ref=e91] [cursor=pointer]
      - generic [ref=e92]:
        - button "经典工作台" [ref=e93] [cursor=pointer]
        - button "全局资料库" [ref=e98] [cursor=pointer]
        - button "设置" [ref=e101] [cursor=pointer]
      - generic [ref=e105]:
        - generic [ref=e107]: 已保存到本地
        - button "存储与设置" [ref=e108] [cursor=pointer]
      - button "目录文件已更新" [ref=e113] [cursor=pointer]
      - separator "调整左侧宽度" [ref=e114]
    - generic [ref=e115]:
      - banner [ref=e116]:
        - generic [ref=e117]:
          - button "主区返回" [disabled] [ref=e118]
          - button "返回会话" [ref=e121] [cursor=pointer]:
            - generic [ref=e124]: 完整对话
          - textbox "研究名称" [ref=e125]:
            - /placeholder: 未命名研究
            - text: 检索增强，何时有效？
        - generic [ref=e126]:
          - button "文献信息" [ref=e127] [cursor=pointer]
          - generic [ref=e128]: 已保存
          - button "围绕这里追问" [ref=e131] [cursor=pointer]
          - button "卡片与摘录" [ref=e135] [cursor=pointer]
          - button "聊天" [pressed] [ref=e140] [cursor=pointer]
          - button "添加资料" [ref=e143] [cursor=pointer]
          - button "展开右侧面板" [ref=e145] [cursor=pointer]
      - generic [ref=e149]:
        - main "主工作区" [ref=e150]:
          - region "中央窗格工作区" [ref=e151]:
            - region "工作区窗格 1" [ref=e154]:
              - generic [ref=e155]:
                - tablist "窗格 1 标签" [ref=e156]:
                  - generic [ref=e157]:
                    - 'tab "Adaptive Retrieval: Evidence & Reliability" [selected] [ref=e158]'
                    - 'button "关闭标签 Adaptive Retrieval: Evidence & Reliability" [ref=e162] [cursor=pointer]'
                - button "窗格 1 操作" [ref=e166] [cursor=pointer]:
                  - generic [ref=e169]: 分屏
                - button "放大窗格 1" [disabled] [ref=e170]
              - region "PDF 阅读器" [ref=e177]:
                - generic [ref=e178]:
                  - button "上次提问" [ref=e179] [cursor=pointer]
                  - button "目录与全文搜索" [ref=e180] [cursor=pointer]
                  - group "PDF 选择方式" [ref=e182]:
                    - button "文字选择" [pressed] [ref=e183] [cursor=pointer]
                    - button "区域框选" [ref=e187] [cursor=pointer]
                  - generic [ref=e193]:
                    - button "上一页" [disabled] [ref=e194]
                    - generic [ref=e197]:
                      - spinbutton "PDF 页码" [ref=e198]: "1"
                      - generic [ref=e199]: / 3
                    - button "下一页" [ref=e200] [cursor=pointer]
                  - generic [ref=e203]:
                    - button "缩小 PDF" [ref=e204] [cursor=pointer]
                    - button "100%" [ref=e206] [cursor=pointer]
                    - button "放大 PDF" [ref=e207] [cursor=pointer]
                  - group "阅读状态" [ref=e209]:
                    - button "略读过" [ref=e210] [cursor=pointer]
                    - button "读完" [ref=e211] [cursor=pointer]
                - generic [ref=e212]:
                  - generic [ref=e213]: 阅读就绪
                  - generic [ref=e214]: 文本已就绪 · 可选择原文
                - generic "连续滚动阅读区域" [ref=e215]:
                  - generic [ref=e216]:
                    - generic [ref=e217]:
                      - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 1 页" [ref=e218]'
                      - generic [ref=e219]: READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 1 Abstract This self-authored fixture describes an imaginary comparison between a fixed retrieval baseline and an adaptive evidence selection method. Its purpose is to exercise reading, text selection, citation navigation, and research notes in the Read-paper workbench. All methods, data, and results are synthetic. They must not be used as claims about a real system or publication. The document includes ordinary selectable text and stable page boundaries for reproducible product tests. 1. Research question When does adding a retrieval stage improve the factual quality of an answer? We compare answers grounded in a relevant evidence collection with answers grounded in a collection containing unrelated material. A useful comparison records the question, the available sources, the selected evidence, and the resulting answer. The answer can then be checked against the same source excerpts that were available at generation time. 2. Evidence collection The imaginary corpus contains short notes about a single research question. Each note has an identifier, a page number, and an excerpt. We retain these fields together because a quote without its source cannot support a reviewable conclusion.
                      - generic "原文操作标记":
                        - button "查看此处记录 · 2条" [ref=e220] [cursor=pointer]: "2"
                    - generic [ref=e221]:
                      - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 2 页" [ref=e222]'
                      - generic [ref=e223]: READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 2 3. Synthetic procedure The fixed baseline always selects two notes. The adaptive method first checks whether a candidate note is relevant to the question, then chooses up to two relevant notes. Both methods receive the same synthetic corpus and the same answer length limit. A reviewer marks each statement as supported, contradicted, or absent from the selected notes. Supported statements are counted only when the source excerpt can be recovered by its document identifier and PDF page index. 4. Imaginary results In the relevant-corpus condition, the adaptive method produces more supported statements. In the unrelated-corpus condition, selecting additional notes does not create useful evidence. These are invented observations for software verification. Relevance is a condition of the example, not a universal property of retrieval. The test deliberately preserves this qualification so that cards and conclusions can represent both the claim and its limits. 5. Reproducibility notes A reliable answer should preserve a traceable link to its supporting evidence. The fixture generator fixes metadata dates, typography, page size, and content. Re-running the generator should create the same bytes. The paper uses a single text column and three PDF pages. Text extraction and rendering are separate capabilities. This fixture has a text layer, while the accompanying scanned research note contains a raster image and no selectable page text.
                      - generic "原文操作标记":
                        - button "查看此处记录 · 1条" [ref=e224] [cursor=pointer]: "1"
                    - generic [ref=e225]:
                      - 'generic "Adaptive Retrieval: Evidence & Reliability PDF 第 3 页" [ref=e226]'
                      - generic [ref=e227]: "READ-PAPER / RESEARCH MATERIAL Adaptive Retrieval for Evidence-Grounded Answers Synthetic research fixture, not a real publication. Fixture only | PDF page 3 6. Main finding Retrieval improves factual accuracy when the evidence corpus is relevant. This exact sentence is the selection target for the end-to-end research workflow. It is intentionally located on PDF page 3, whose internal page index is 2. It should remain selectable after zooming or reopening the document. 7. Conditions and limits The finding is conditional on source relevance and recoverable citations. A fluent answer may still contain unsupported details. Reviewers should inspect the original excerpt rather than treating the presence of a citation as proof of correctness. The fixture makes no claim about real benchmark performance. It exists to demonstrate evidence cards, shared card reuse, board organization, and a conclusion export that includes bibliography details, PDF page numbers, and quotations. 8. Conclusion A research note is easier to verify when its claims preserve the conditions under which they were observed. Explicit source excerpts let the reader revisit the same evidence while writing a conclusion. Suggested synthetic citation: Read-paper fixture authors (2026). Adaptive Retrieval for Evidence-Grounded Answers. Self-authored software test material; not a real publication."
                      - generic "原文操作标记":
                        - button "查看此处记录 · 1条" [ref=e228] [cursor=pointer]: "1"
                - generic [ref=e229]:
                  - generic [ref=e230]: adaptive-retrieval.pdf
                  - generic [ref=e231]: PDF 第 1 页 · 100%
        - region "当前会话" [ref=e232]:
          - generic [ref=e233]:
            - button "选择会话" [ref=e234] [cursor=pointer]:
              - generic [ref=e237]: 条件比较 A
            - generic [ref=e240]:
              - button "重命名会话：条件比较 A" [ref=e241] [cursor=pointer]
              - button "删除会话：条件比较 A" [ref=e245] [cursor=pointer]
              - button "侧边聊天" [pressed] [ref=e249] [cursor=pointer]
              - button "浮窗聊天" [ref=e252] [cursor=pointer]
              - button "展开聊天" [ref=e255] [cursor=pointer]
              - button "关闭聊天" [ref=e261] [cursor=pointer]
          - separator "调整聊天宽度" [ref=e265]
          - generic [ref=e266]:
            - region "当前研究会话" [ref=e268]:
              - generic [ref=e269]:
                - heading "你想弄清楚什么？" [level=2] [ref=e270]
                - paragraph [ref=e271]: 描述目标，让 Agent 查找研究资料、读原文，整理出可继续编辑的成果。
                - generic "研究目标示例" [ref=e272]:
                  - button "比较这些论文的方法、适用条件与局限，写一份带引用的研究笔记。" [ref=e273] [cursor=pointer]
                  - button "先找出这些研究之间最值得继续追问的问题。" [ref=e276] [cursor=pointer]
              - group [ref=e279]:
                - generic "本研究的共享成果" [ref=e280] [cursor=pointer]
            - region "研究 Agent" [ref=e281]:
              - generic [ref=e282]:
                - textbox "研究目标" [ref=e283]:
                  - /placeholder: 在当前会话继续研究，或围绕选定内容追问…
                - generic [ref=e284]:
                  - button "选择研究助手" [ref=e285] [cursor=pointer]: Codex
                  - generic "仅使用已关联研究资料；成果与修改建议在应用中保存" [ref=e288]: 只读资料
                  - button "添加图片" [ref=e289] [cursor=pointer]
                  - button "语音输入" [ref=e295] [cursor=pointer]:
                    - generic [ref=e299]: 语音
                  - button "开始研究" [disabled] [ref=e300]
  - dialog "原文旁提问" [ref=e304]:
    - banner [ref=e305]:
      - button "移动原文旁问答" [ref=e306]:
        - strong [ref=e314]: 提问
      - generic [ref=e315]: PDF 第 1 页
      - button "重命名会话：解释这个公式的假设，只按我选择的原文回答。" [ref=e316] [cursor=pointer]
      - button "关闭就地问答并保留内容" [ref=e320] [cursor=pointer]
    - generic [ref=e324]:
      - group [ref=e325]:
        - generic "所选原文 查看来源" [ref=e326] [cursor=pointer]:
          - text: 所选原文
          - generic [ref=e327]: 查看来源
      - button "移除标记" [ref=e328] [cursor=pointer]
    - generic [ref=e329]:
      - generic [ref=e330]: 正在生成本篇文章简要…
      - button "先只问选区" [ref=e331] [cursor=pointer]
    - generic [ref=e332]:
      - article [ref=e333]:
        - paragraph [ref=e334]: 解释这个公式的假设，只按我选择的原文回答。
        - group [ref=e335]:
          - generic "当轮上下文" [ref=e336] [cursor=pointer]
        - status [ref=e337]:
          - generic [ref=e338]: 已停止，已保留部分内容。
      - article [ref=e339]:
        - paragraph [ref=e340]: 解释这个公式的假设，只按我选择的原文回答。
        - group [ref=e341]:
          - generic "当轮上下文" [ref=e342] [cursor=pointer]
        - status [ref=e343]: 正在理解所选内容…
    - button "在右侧继续" [ref=e345] [cursor=pointer]
    - generic [ref=e348]:
      - textbox "向原文旁助手提问" [ref=e349]:
        - /placeholder: 继续问这段原文…
      - button "停止就地回答" [ref=e350] [cursor=pointer]
    - button "调整原文旁问答大小" [ref=e353]
```

# Test source

```ts
  10  | const error = (message: string) => [{ type: 'error', error: message }];
  11  | async function services(page: Page, respond: (payload: Payload) => object[] | Promise<object[]>) {
  12  |   const fixture = await installControlledServices(page), calls: Payload[] = [];
  13  |   await page.route('**/api/ai/agents/stop', route => route.fulfill({ json: { stopped: true } }));
  14  |   for (const endpoint of ['chat', 'agents/run']) await page.route(`**/api/ai/${endpoint}`, async route => {
  15  |     const payload = route.request().postDataJSON() as Payload; calls.push(payload);
  16  |     await route.fulfill({ contentType: 'application/x-ndjson', body: ndjson(await respond(payload)) });
  17  |   });
  18  |   return { fixture, calls };
  19  | }
  20  | async function select(page: Page, kind: 'text' | 'region') {
  21  |   if (kind === 'text') await selectPassage(page);
  22  |   else {
  23  |     await main(page).getByRole('button', { name: '区域框选', exact: true }).click();
  24  |     const layer = main(page).getByLabel('拖动框选当前 PDF 页区域', { exact: true }).first(), bounds = (await layer.boundingBox())!;
  25  |     await page.mouse.move(bounds.x + bounds.width * .12, bounds.y + bounds.height * .08); await page.mouse.down();
  26  |     await page.mouse.move(bounds.x + bounds.width * .68, bounds.y + bounds.height * .24, { steps: 15 }); await page.mouse.up();
  27  |   }
  28  |   await selectionMenu(page).getByRole('button', { name: '提问', exact: true }).click();
  29  |   await inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true }).fill('解释这个公式的假设，只按我选择的原文回答。');
  30  | }
  31  | async function shot(page: Page, name: string) {
  32  |   await mkdir('docs/verification/reader-brief-failure/screenshots', { recursive: true });
  33  |   await saved(page); await page.evaluate(() => document.fonts.ready);
  34  |   await page.screenshot({ path: `docs/verification/reader-brief-failure/screenshots/${name}.png` });
  35  | }
  36  | 
  37  | for (const kind of ['text', 'region'] as const) test(`${kind}真实选区简要报旧卡片格式错误后可见降级，问题只发一次且来源保持`, async ({ page }) => {
  38  |   const { fixture, calls } = await services(page, payload => payload.purpose === 'brief' ? error(legacyError) : answer('受控公式解释：假设仅限当前选区，未附送内容仍未知。[1]'));
  39  |   await page.goto('/'); await openSeedPaper(page);
  40  |   await composer(page).fill('主会话未发送输入，不应混入原文问题');
  41  |   await select(page, kind); await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  42  |   await expect(inline(page)).toContainText('受控公式解释');
  43  |   await expect(inline(page)).toContainText('文章简要暂不可用 · 本轮仅使用选区');
  44  |   await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('');
  45  |   await expect(composer(page)).toHaveValue('主会话未发送输入，不应混入原文问题');
  46  |   expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
  47  |   const data = await readData(page), request = Object.values(data.requests).find(item => item.readerOperation === 'question')!;
  48  |   expect(request).toMatchObject({ status: 'done', paperBriefState: 'error' });
  49  |   expect(request.result).toBeUndefined(); expect(request.paperBrief).toBeUndefined();
  50  |   expect(request.context).toHaveLength(1); expect(request.context[0]).toMatchObject({ documentId: 'paper-a', pageIndex: 0 });
  51  |   expect(request.context[0].kind ?? 'text').toBe(kind);
  52  |   expect(request.materials?.some(item => item.id.startsWith('paper-brief:')) ?? false).toBe(false);
  53  |   expect(Object.keys(data.cardDrafts)).toHaveLength(0);
  54  |   if (kind === 'region') {
  55  |     expect(calls[1].images).toHaveLength(1);
  56  |     expect(calls[1].images![0]).toMatchObject({ evidenceId: request.context[0].evidenceId, dataUrl: expect.stringMatching(/^data:image\/png;base64,iVBOR/) });
  57  |     expect(request.context[0].region!.rect.width).toBeCloseTo(.56, 2);
  58  |     expect(request.context[0].region!.rect.height).toBeCloseTo(.16, 2);
  59  |   }
  60  |   for (const [width, height] of kind === 'region' ? [[1440, 900], [1280, 800], [1024, 800]] : [[1440, 900]]) {
  61  |     await page.setViewportSize({ width, height });
  62  |     await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toBeInViewport({ ratio: 1 });
  63  |     expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  64  |     await shot(page, `${kind}-brief-fallback-${width}`);
  65  |   }
  66  |   await inline(page).getByRole('button', { name: '关闭就地问答并保留内容', exact: true }).click();
  67  |   await saved(page); await page.reload(); await openSeedPaper(page);
  68  |   await main(page).getByRole('button', { name: '上次提问', exact: true }).click();
  69  |   await expect(inline(page)).toContainText('受控公式解释');
  70  |   await expect(inline(page)).toContainText('文章简要暂不可用 · 本轮仅使用选区');
  71  |   expect(calls.map(call => call.purpose)).toEqual(['brief', 'chat']);
  72  |   fixture.assertClean();
  73  | });
  74  | 
  75  | test('简要与真正问题均失败时输入保留，连续点击重试也只增加一轮真正问题', async ({ page }) => {
  76  |   let chats = 0, release!: () => void;
  77  |   const { fixture, calls } = await services(page, async payload => {
  78  |     if (payload.purpose === 'brief') return error(legacyError);
  79  |     if (++chats === 1) return error('受控真正问题暂时失败');
  80  |     await new Promise<void>(resolve => { release = resolve; }); return answer('重试后按原始选区回答。[1]');
  81  |   });
  82  |   await page.goto('/'); await openSeedPaper(page); await select(page, 'text');
  83  |   await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  84  |   await expect(inline(page)).toContainText('受控真正问题暂时失败');
  85  |   await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('解释这个公式的假设，只按我选择的原文回答。');
  86  |   const before = await readData(page), original = Object.values(before.requests).find(item => item.readerOperation === 'question')!;
  87  |   await inline(page).getByRole('button', { name: '重试', exact: true }).dblclick();
  88  |   await expect.poll(() => !!release).toBe(true); release();
  89  |   await expect(inline(page)).toContainText('重试后按原始选区回答');
  90  |   expect(calls.filter(call => call.purpose === 'chat')).toHaveLength(2);
  91  |   const after = await readData(page), requests = Object.values(after.requests).filter(item => item.readerOperation === 'question');
  92  |   expect(requests).toHaveLength(2);
  93  |   expect(requests.find(item => item.retryOf === original.id)).toMatchObject({ status: 'done', context: original.context });
  94  |   await shot(page, 'retry-retains-original-question'); fixture.assertClean();
  95  | });
  96  | 
  97  | test('等待简要时停止，迟到失败不能继续发送问题，原输入保留', async ({ page }) => {
  98  |   let release!: () => void;
  99  |   const { fixture, calls } = await services(page, async payload => {
  100 |     if (payload.purpose !== 'brief') return answer('不应出现的回答');
  101 |     await new Promise<void>(resolve => { release = resolve; }); return error(legacyError);
  102 |   });
  103 |   await page.goto('/'); await openSeedPaper(page); await select(page, 'text');
  104 |   await inline(page).getByRole('button', { name: '发送就地问题', exact: true }).click();
  105 |   await expect.poll(() => !!release).toBe(true);
  106 |   await inline(page).getByRole('button', { name: '停止就地回答', exact: true }).click(); release();
  107 |   await expect(inline(page)).toContainText('已停止');
  108 |   await expect(inline(page).getByRole('textbox', { name: '向原文旁助手提问', exact: true })).toHaveValue('解释这个公式的假设，只按我选择的原文回答。');
  109 |   await saved(page);
> 110 |   expect(calls.map(call => call.purpose)).toEqual(['brief']);
      |                                           ^ Error: expect(received).toEqual(expected) // deep equality
  111 |   expect(Object.values((await readData(page)).requests).find(item => item.readerOperation === 'question')?.status).toBe('stopped');
  112 |   fixture.assertClean();
  113 | });
  114 | 
```