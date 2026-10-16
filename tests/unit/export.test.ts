import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import {
  exportMarkdown,
  remapCitationNumbers,
} from '../../src/features/export/exportMarkdown';

describe('Markdown 研究笔记导出', () => {
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
});
