import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import type { AIHistoryTurn, ContextSnapshot } from '../../src/domain/types';
import { hasOriginalDocument, originalAnswerContext } from '../../src/features/ai/SourceDetails';

describe('历史问答的原始来源', () => {
  const a: ContextSnapshot = { evidenceId: 'a', documentId: 'paper-a', documentHash: 'original', title: 'A', pageIndex: 0, quote: 'A 原文' };
  const b: ContextSnapshot = { ...a, evidenceId: 'b', title: 'B', quote: 'B 原文' };
  it('原答只引用第二份材料时，[1] 对应 B 而不是全材料中的 A', () => {
    const turn: AIHistoryTurn = { requestId: 'request', prompt: '问题', body: '来自 B [1]', evidenceIds: ['b'], context: [a, b] };
    expect(originalAnswerContext(turn)).toEqual([b]);
  });
  it('原文件改名仍可定位，替换为不同版本后禁止跳到新文件', () => {
    const data = createSeed();
    data.documents['paper-a'].hash = a.documentHash;
    data.documents['paper-a'].title = '后来改过的名称';
    expect(hasOriginalDocument(data, a)).toBe(true);
    data.documents['paper-a'].hash = 'replacement';
    expect(hasOriginalDocument(data, a)).toBe(false);
    expect(a.quote).toBe('A 原文');
  });
  it('缺文件或旧记录没有版本身份时不声明可以定位原文件', () => {
    const data = createSeed();
    expect(hasOriginalDocument(data, { ...a, documentHash: '' })).toBe(false);
    delete data.documents['paper-a'];
    expect(hasOriginalDocument(data, a)).toBe(false);
  });
});
