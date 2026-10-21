import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import type { CardProvenance, ResearchMaterial } from '../../src/domain/types';
import {
  draftConversationSources,
  exportMarkdown,
  insertCardReference,
  insertEvidenceReferences,
  remapCitationNumbers,
} from '../../src/features/export/exportMarkdown';

function conversationSource(selection = '相关的证据才能支持可靠结论。'): CardProvenance {
  return {
    researchId: 'research-a',
    conversationId: 'conversation-origin',
    conversationTitle: '相关性讨论',
    requestId: 'request-origin',
    prompt: '如何理解证据相关性？',
    answer: '完整回答中的未选内容不应默认导出。\n相关的证据才能支持可靠结论。',
    selection,
    context: [],
    createdAt: '2026-10-16T02:00:00.000Z',
    model: 'test-model',
    generationRequestIds: ['request-card', 'request-revision'],
  };
}

describe('Markdown 研究笔记导出', () => {
  it('摘要形成的 AI 卡片保留冻结来源、版本和派生链，不伪造 PDF 编号或页码', () => {
    const data = createSeed();
    const material: ResearchMaterial = { id: 'openalex-W9003', kind: 'abstract', title: '形成时的摘要来源', text: '摘要只描述了适用条件。', version: 'abstract-before-edit', provider: 'openalex', providerId: 'W9003', url: 'https://example.org/abstract-source', retrievedAt: '2026-10-20T10:00:00.000Z' };
    const source = conversationSource('基于摘要的 AI 理解，仍需阅读全文核查。');
    source.context = [];
    source.answerEvidenceIds = [];
    source.materials = [material, { id: 'card:prior', kind: 'card_note', title: '前一张卡片', text: '用户明确保留的早期理解。', version: 'note-v1', derivedFrom: { sourceIds: [material.id], requestIds: ['prior-request'] } }];
    source.derivedFrom = { sourceIds: [material.id], requestIds: [source.requestId] };
    data.cards['card-a'].provenance = source;
    data.cards['card-a'].evidenceIds = [];
    data.cards['card-a'].body = '基于摘要的待核查理解。';
    insertCardReference(data, 'draft-b', 'card-a');
    material.text = '后来被改掉的摘要';
    source.materials[0].url = 'https://example.org/later';
    source.selection = '后来改掉的回答';
    const markdown = exportMarkdown(data, 'draft-b');
    expect(markdown).toContain('基于摘要的 AI 理解，仍需阅读全文核查');
    expect(markdown).toContain('题录与来源摘要');
    expect(markdown).toContain('https://example.org/abstract-source');
    expect(markdown).toContain('摘要只描述了适用条件');
    expect(markdown).toContain('abstract-before-edit');
    expect(markdown).toContain('2026-10-20T10:00:00.000Z');
    expect(markdown).toContain('派生来源：openalex-W9003；问答轮次：prior-request');
    expect(markdown).toContain('非 PDF 原文证据');
    expect(markdown).toContain('本稿尚未附加原文证据');
    expect(markdown).not.toMatch(/PDF 第 \d+ 页/);
    expect(markdown).not.toContain('原答 [1]');
    expect(markdown).not.toContain('后来被改掉');
    expect(markdown).not.toContain('https://example.org/later');
    expect(data.drafts['draft-b'].evidenceIds).toEqual([]);
  });

  it('包含核心问题、结论、文献、从 1 开始的 PDF 页码与摘录，并去重引用', () => {
    const data = createSeed();
    data.drafts['draft-a'].evidenceIds.push('evidence-a');
    data.evidence['evidence-a'].printedPage = '12';
    const markdown = exportMarkdown(data, 'draft-a');
    expect(markdown).toContain('# 检索增强的适用条件');
    expect(markdown).toContain(data.researches['research-a'].question);
    expect(markdown).toContain(data.drafts['draft-a'].body);
    expect(markdown).toContain(data.documents['paper-a'].authors);
    expect(markdown).toContain('PDF 第 3 页（印刷页码：12）');
    expect(markdown).toContain('> Retrieval improves factual accuracy');
    expect(markdown.match(/### \[\d\]/g)).toHaveLength(2);
    expect(markdown).toContain('未附带原始 PDF');
  });

  it.each([
    'missing-evidence',
    'missing-document',
    'invalid-page',
    'empty-quote',
    'outside-research',
  ])('阻止失效引用：%s', (problem) => {
    const data = createSeed();
    if (problem === 'missing-evidence') delete data.evidence['evidence-a'];
    if (problem === 'missing-document') delete data.documents['paper-a'];
    if (problem === 'invalid-page') data.evidence['evidence-a'].pageIndex = 3;
    if (problem === 'empty-quote') data.evidence['evidence-a'].quote = ' ';
    if (problem === 'outside-research')
      data.researches['research-a'].documentIds = ['paper-b'];
    expect(() => exportMarkdown(data, 'draft-a')).toThrow(/引用/);
  });

  it('不依赖白板，允许明确无引用的草稿导出', () => {
    const data = createSeed();
    data.boards = {};
    expect(exportMarkdown(data, 'draft-a')).toContain('## 引用与原文证据');
    expect(exportMarkdown(data, 'draft-b')).toContain('本稿尚未附加原文证据');
  });

  it('阻止手工写入的越界引用编号', () => {
    const data = createSeed();
    for (const number of [0, -1, 3]) {
      data.drafts['draft-a'].body = `研究结论 [${number}]`;
      expect(() => exportMarkdown(data, 'draft-a')).toThrow(/引用.*没有对应/);
    }
    data.drafts['draft-a'].body = '研究结论 [2]';
    expect(exportMarkdown(data, 'draft-a')).toContain('研究结论 [2]');
  });

  it('将卡片局部引用映射为结论的已有来源编号', () => {
    expect(
      remapCitationNumbers(
        '无关材料存在风险 [1]',
        ['evidence-b'],
        ['evidence-a', 'evidence-b'],
      ),
    ).toBe('无关材料存在风险 [2]');
    expect(
      remapCitationNumbers(
        '收益有条件 [2]，并应核查 [1]',
        ['evidence-b', 'evidence-a'],
        ['evidence-a', 'evidence-b'],
      ),
    ).toBe('收益有条件 [1]，并应核查 [2]');
  });

  it('局部引用缺少证据时阻止卡片引用映射', () => {
    expect(() =>
      remapCitationNumbers(
        '无效观点 [2]',
        ['evidence-b'],
        ['evidence-a', 'evidence-b'],
      ),
    ).toThrow(/修复引用编号/);
    expect(() =>
      remapCitationNumbers('缺失来源 [1]', ['evidence-b'], ['evidence-a']),
    ).toThrow(/修复引用编号/);
  });

  it('插入时冻结双来源并关联研究，后续卡片或会话变化不会改写结论来源', () => {
    const data = createSeed();
    data.cards['card-a'].provenance = conversationSource();
    data.cards['card-a'].provenance!.context = [{
      evidenceId: 'evidence-a', documentId: 'paper-a', documentHash: 'original-hash',
      title: '原文标题', pageIndex: 2, quote: '创建时的原文摘录',
    }];
    const cursor = insertCardReference(data, 'draft-b', 'card-a');
    expect(cursor).toBe(data.drafts['draft-b'].body.length);
    expect(data.researches['research-b'].cardIds).toContain('card-a');
    expect(data.researches['research-b'].documentIds).toContain('paper-a');
    expect(data.drafts['draft-b'].body).toContain('[1]');
    data.cards['card-a'].title = '后来改过的标题';
    data.cards['card-a'].body = '后来改过的正文';
    data.cards['card-a'].provenance!.selection = '后来改过的来源';
    data.cards['card-a'].provenance!.context[0].quote = '后来改过的原文摘录';
    expect(data.drafts['draft-b'].cardSources![0].provenance.context[0].quote).toBe('创建时的原文摘录');
    data.conversations = {};
    data.requests = {};
    const markdown = exportMarkdown(data, 'draft-b');
    expect(markdown).toContain('相关性是检索收益的前提');
    expect(markdown).toContain('> 相关的证据才能支持可靠结论。');
    expect(markdown).toContain('用户问题：\n\n> 如何理解证据相关性？');
    expect(markdown).toContain('请求 ID：request-origin');
    expect(markdown).toContain('时间：2026-10-16T02:00:00.000Z');
    expect(markdown).toContain('模型：test-model');
    expect(markdown).toContain('request-card、request-revision');
    expect(markdown).toContain('原答 [1] → 原文标题 · PDF 第 3 页');
    expect(markdown).toContain('> 创建时的原文摘录');
    expect(markdown).not.toContain('后来改过');
    expect(markdown).not.toContain('完整回答中的未选内容');
  });

  it('同一问答的同一片段去重并保留各卡片 ID，不同知识点独立导出', () => {
    const data = createSeed();
    data.cards['card-a'].provenance = conversationSource();
    data.cards['card-b'].provenance = conversationSource();
    data.cards['card-c'].provenance = conversationSource('另一个知识点：保留可追溯的来源。');
    for (const id of ['card-a', 'card-b', 'card-a', 'card-c']) insertCardReference(data, 'draft-b', id);
    const sources = draftConversationSources(data.drafts['draft-b']);
    expect(sources).toHaveLength(2);
    expect(sources[0].cardIds).toEqual(['card-a', 'card-b']);
    const markdown = exportMarkdown(data, 'draft-b');
    expect(markdown.match(/### 对话来源 /g)).toHaveLength(2);
    expect(markdown).toContain('卡片 ID：card-a、card-b');
    expect(markdown).toContain('另一个知识点：保留可追溯的来源。');
  });

  it('仅对话卡可以引用，但不会伪造论文编号或论文关联', () => {
    const data = createSeed();
    data.cards['card-a'].provenance = conversationSource();
    data.cards['card-a'].evidenceIds = [];
    data.cards['card-a'].body = '这是一条仍需核查的解释。';
    data.cards['card-a'].needsReview = true;
    insertCardReference(data, 'draft-b', 'card-a');
    expect(data.drafts['draft-b'].evidenceIds).toEqual([]);
    expect(data.researches['research-b'].documentIds).toEqual([]);
    const markdown = exportMarkdown(data, 'draft-b');
    expect(markdown).toContain('本稿尚未附加原文证据');
    expect(markdown).toContain('## 相关对话来源');
    expect(markdown).not.toContain('[1]');
  });

  it('原答编号使用实际引用顺序，只导出引用 B 的冻结材料，不混入未引用上下文 A', () => {
    const data = createSeed();
    const source = conversationSource('无关材料可能增加不确定性 [1]。');
    source.answerEvidenceIds = ['evidence-b'];
    source.context = [
      {
        evidenceId: 'evidence-a', documentId: 'paper-a', documentHash: 'hash-a',
        title: '未引用的上下文 A', pageIndex: 2, quote: 'A 的未引用摘录不应默认导出。',
      },
      {
        evidenceId: 'evidence-b', documentId: 'paper-b', documentHash: 'hash-b',
        title: '创建时的文献 B', pageIndex: 0, quote: '创建时的 B 摘录。',
      },
    ];
    data.cards['card-a'].provenance = source;
    data.cards['card-a'].evidenceIds = [];
    data.cards['card-a'].body = '这条解释尚待核查。';
    insertCardReference(data, 'draft-b', 'card-a');
    data.evidence = {};
    data.documents = {};
    const markdown = exportMarkdown(data, 'draft-b');
    expect(markdown).toContain('> 无关材料可能增加不确定性 [1]。');
    expect(markdown).toContain('独立编号，不是结论的引用编号');
    expect(markdown).toContain('原答 [1] → 创建时的文献 B · PDF 第 1 页');
    expect(markdown).toContain('> 创建时的 B 摘录。');
    expect(markdown).not.toContain('未引用的上下文 A');
    expect(markdown).not.toContain('A 的未引用摘录');
    expect(markdown).not.toContain('原答 [2]');
  });

  it('阻止失效来源卡写入，已有结论及研究关联保持完整', () => {
    const data = createSeed();
    delete data.evidence['evidence-a'];
    const before = structuredClone(data);
    expect(() => insertCardReference(data, 'draft-b', 'card-a')).toThrow(/引用/);
    expect(data).toEqual(before);
    data.cards['card-a'].evidenceIds = [];
    data.cards['card-a'].provenance = conversationSource();
    data.cards['card-a'].body = '无论文的解释却有虚构引用 [1]';
    expect(() => insertCardReference(data, 'draft-b', 'card-a')).toThrow(/引用/);
  });

  it('区域证据无需文字摘录，导出元数据并明确未附图片和 PDF', () => {
    const data = createSeed();
    data.evidence['evidence-a'] = {
      ...data.evidence['evidence-a'],
      kind: 'region', quote: '',
      region: {
        assetId: 'region-image', hash: 'region-content-hash',
        rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
        rotation: 90, width: 640, height: 480,
      },
    };
    const markdown = exportMarkdown(data, 'draft-a');
    expect(markdown).toContain('PDF 第 3 页');
    expect(markdown).toContain('区域坐标（页面归一化）：x=0.1, y=0.2, width=0.4, height=0.3');
    expect(markdown).toContain('旋转：90°');
    expect(markdown).toContain('区域图片 hash：region-content-hash');
    expect(markdown).toContain('未附带原始 PDF，未附带区域图片');
    expect(markdown).toContain('不是可在其他设备打开的云链接');
    data.evidence['evidence-a'].region!.rect.width = 1;
    expect(() => exportMarkdown(data, 'draft-a')).toThrow(/引用.*区域来源/);
    delete data.evidence['evidence-a'].region;
    expect(() => exportMarkdown(data, 'draft-a')).toThrow(/引用.*区域来源/);
  });
});

it('补引用只在光标处插入去重编号，保留正文、卡片使用记录与研究关联', () => {
  const data = createSeed();
  const draft = data.drafts['draft-a'];
  draft.body = '前文，后文。';
  const refs = structuredClone(draft.cardRefs);
  const cursor = insertEvidenceReferences(data, draft.id, ['evidence-a', 'evidence-c', 'evidence-a'], 3);
  expect(draft.body).toBe('前文，[1][3]后文。');
  expect(cursor).toBe(9);
  expect(draft.evidenceIds).toEqual(['evidence-a', 'evidence-b', 'evidence-c']);
  expect(draft.cardRefs).toEqual(refs);
  expect(() => insertEvidenceReferences(data, draft.id, ['missing'])).toThrow(/引用/);
});
it('插入无依据卡片也记录卡片，供结论问题推导，不伪造原文编号', () => {
  const data = createSeed();
  insertCardReference(data, 'draft-b', 'card-unverified');
  expect(data.drafts['draft-b'].cardRefs).toEqual([{ cardId: 'card-unverified', insertedAt: expect.any(String), evidenceIds: [] }]);
  expect(data.drafts['draft-b'].evidenceIds).toEqual([]);
  expect(data.drafts['draft-b'].body).toBe(data.cards['card-unverified'].body);
});
