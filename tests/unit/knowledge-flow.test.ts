import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { conclusionIssues, hasFullText, normalizeIdentifier, researchEvidence } from '../../src/domain/knowledge';
import { workspace } from '../../src/services/workspace';

vi.mock('../../src/data/storage', () => ({
  loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), restoreWorkspaceBackup: vi.fn(),
}));

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  await workspace.load();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('本地资料标识', () => {
  it.each([
    ['DOI: 10.1000/AbC', 'doi', '10.1000/abc'],
    ['https://doi.org/10.1000/AbC', 'doi', '10.1000/abc'],
    ['https://dx.doi.org/10.1000/ABC', 'doi', '10.1000/abc'],
    ['arXiv: 1706.03762v7', 'arxiv', '1706.03762'],
    ['https://arxiv.org/pdf/1706.03762v2.pdf', 'arxiv', '1706.03762'],
    ['https://arxiv.org/abs/hep-th/9901001v3', 'arxiv', 'hep-th/9901001'],
    [' https://example.com/paper#section ', 'url', 'https://example.com/paper'],
  ])('规范化 %s', (raw, kind, value) => {
    expect(normalizeIdentifier(raw)).toEqual({ kind, value });
  });

  it.each(['', '任意标题', 'javascript:alert(1)', 'file:///paper.pdf', 'ftp://example.com/paper'])('不把 %s 当作联网标识', raw => {
    expect(normalizeIdentifier(raw)).toBeUndefined();
  });

  it('相同规范标识只存一个稳定条目，并独立关联各研究', () => {
    const first = workspace.addSource({ kind: 'identifier', raw: 'https://doi.org/10.1000/AbC' }, { kind: 'research', researchId: 'research-a' });
    const second = workspace.addSource({ kind: 'identifier', raw: 'doi:10.1000/abc' }, { kind: 'research', researchId: 'research-b' });
    expect(first.created).toBe(true);
    expect(first.documentId).toMatch(/^document-/);
    expect(second).toEqual({ documentId: first.documentId, created: false });
    const data = workspace.getState().data;
    expect(data.researches['research-a'].documentIds).toContain(first.documentId);
    expect(data.researches['research-b'].documentIds).toEqual([first.documentId]);
    expect(data.documents[first.documentId].identifiers).toEqual({ doi: '10.1000/abc' });
    expect(hasFullText(data.documents[first.documentId])).toBe(false);
    const libraryOnly = workspace.addSource({ kind: 'title', title: '  新的研究材料  ' }, { kind: 'library' });
    expect(data.documents[libraryOnly.documentId]).toBeUndefined();
    expect(workspace.getState().data.documents[libraryOnly.documentId].title).toBe('新的研究材料');
    expect(workspace.getState().data.researches['research-a'].documentIds).not.toContain(libraryOnly.documentId);
  });

  it('无效输入或目标研究不存在时保持资料与研究关联不变', () => {
    const before = structuredClone(workspace.getState().data);
    expect(() => workspace.addSource({ kind: 'title', title: '  ' }, { kind: 'library' })).toThrow(/标题/);
    expect(() => workspace.addSource({ kind: 'identifier', raw: '无法识别' }, { kind: 'library' })).toThrow(/标识/);
    expect(() => workspace.addSource({ kind: 'library', documentId: 'missing' }, { kind: 'library' })).toThrow(/不存在/);
    expect(() => workspace.addSource({ kind: 'title', title: '有效标题' }, { kind: 'research', researchId: 'missing' })).toThrow(/研究/);
    expect(workspace.getState().data).toEqual(before);
  });
});

describe('结论问题只由文稿实际使用的卡片和引用推导', () => {
  it('插入的卡片无论文依据时提示找依据，对话来源不代替证据', () => {
    const data = createSeed();
    data.cards['card-unverified'].provenance = { researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话', requestId: 'old-answer', prompt: '问题', answer: '解释', selection: '解释', context: [], generationRequestIds: [], createdAt: '2026-10-17T00:00:00Z' };
    expect(conclusionIssues(data, 'research-a')).toEqual([expect.objectContaining({ kind: 'no-evidence', draftId: 'draft-a', cardId: 'card-unverified' })]);
  });

  it('已插入并引用依据的待核查卡片只提示去核对', () => {
    const data = createSeed();
    Object.assign(data.drafts['draft-a'], { cardRefs: [{ cardId: 'card-b', insertedAt: '2026-10-17T00:00:00Z' }], evidenceIds: ['evidence-b'], body: '已有依据 [1]' });
    expect(conclusionIssues(data, 'research-a')).toEqual([expect.objectContaining({ kind: 'needs-review', cardId: 'card-b' })]);
  });

  it('卡片新增依据后提示补引用，只有正文插入对应编号才消失', () => {
    const data = createSeed();
    Object.assign(data.drafts['draft-a'], { cardRefs: [{ cardId: 'card-a', insertedAt: '2026-10-17T00:00:00Z' }], evidenceIds: ['evidence-a'], body: '尚未引用' });
    expect(conclusionIssues(data, 'research-a')).toEqual([expect.objectContaining({ kind: 'missing-citation', cardId: 'card-a' })]);
    data.drafts['draft-a'].body += ' [1]';
    expect(conclusionIssues(data, 'research-a')).toEqual([]);
    data.cards['card-a'].evidenceIds.push('evidence-c');
    expect(conclusionIssues(data, 'research-a')).toEqual([expect.objectContaining({ kind: 'missing-citation' })]);
    data.drafts['draft-a'].evidenceIds.push('evidence-c');
    data.drafts['draft-a'].body += ' [2]';
    expect(conclusionIssues(data, 'research-a')).toEqual([]);
  });

  it.each(['missing-number', 'missing-evidence', 'missing-document', 'no-fulltext', 'invalid-page'])('识别无法回到原文的正文引用：%s', problem => {
    const data = createSeed();
    Object.assign(data.drafts['draft-a'], { cardRefs: [], evidenceIds: ['evidence-a'], body: '[1]' });
    if (problem === 'missing-number') data.drafts['draft-a'].body = '[7]';
    if (problem === 'missing-evidence') delete data.evidence['evidence-a'];
    if (problem === 'missing-document') delete data.documents['paper-a'];
    if (problem === 'no-fulltext') data.evidence['evidence-a'].documentId = 'paper-stub';
    if (problem === 'invalid-page') data.evidence['evidence-a'].pageIndex = 99;
    expect(conclusionIssues(data, 'research-a')).toEqual([expect.objectContaining({ kind: 'invalid-citation', draftId: 'draft-a' })]);
  });

  it('不把未读、未使用摘录、未插入的卡片或其他研究的问题算作欠账', () => {
    const data = createSeed();
    data.drafts['draft-a'].cardRefs = [];
    const before = structuredClone(data);
    expect(conclusionIssues(data, 'research-a')).toEqual([]);
    expect(conclusionIssues(data, 'research-b')).toEqual([]);
    expect(data).toEqual(before);
  });
});

describe('摘录、共享依据和研究会话', () => {
  it('摘录在研究内去重并保留来源研究；未知来源的旧摘录仍在相关研究可见', () => {
    workspace.addSource({ kind: 'library', documentId: 'paper-a' }, { kind: 'research', researchId: 'research-b' });
    const range = { documentId: 'paper-a', pageIndex: 0, quote: '  新的原文证据  ' };
    const a = workspace.captureExcerpt('research-a', range);
    expect(workspace.captureExcerpt('research-a', { ...range, quote: range.quote.trim() })).toBe(a);
    const b = workspace.captureExcerpt('research-b', range);
    expect(b).not.toBe(a);
    const data = workspace.getState().data;
    expect(researchEvidence(data, 'research-a').map(e => e.id)).toContain(a);
    expect(researchEvidence(data, 'research-a').map(e => e.id)).not.toContain(b);
    expect(researchEvidence(data, 'research-b').map(e => e.id)).toContain(b);
    expect(researchEvidence(data, 'research-b').map(e => e.id)).not.toContain(a);
    expect(researchEvidence(data, 'research-b').map(e => e.id)).toContain('evidence-a');
    workspace.removeExcerpt(a);
    expect(workspace.getState().data.evidence[a]).toBeUndefined();
  });

  it('拒绝无全文、无页码和未关联资料的摘录，失败不改变任何数据', () => {
    const before = structuredClone(workspace.getState().data);
    expect(() => workspace.captureExcerpt('research-a', { documentId: 'paper-stub', pageIndex: 0, quote: '不存在的原文' })).toThrow(/原文|页码/);
    expect(() => workspace.captureExcerpt('research-a', { documentId: 'paper-a', pageIndex: 99, quote: '无效页' })).toThrow(/原文|页码/);
    expect(() => workspace.captureExcerpt('research-a', { documentId: 'paper-a', pageIndex: 0, quote: '  ' })).toThrow(/原文|页码/);
    expect(() => workspace.captureExcerpt('research-b', { documentId: 'paper-a', pageIndex: 0, quote: '未关联' })).toThrow(/加入/);
    expect(workspace.getState().data).toEqual(before);
  });

  it('补依据去重、设为待核查，并为所有复用卡片的研究关联原文', () => {
    workspace.associateCard('research-b', 'card-unverified');
    workspace.attachEvidenceToCard('card-unverified', 'evidence-b');
    workspace.attachEvidenceToCard('card-unverified', 'evidence-b');
    const data = workspace.getState().data;
    expect(data.cards['card-unverified'].evidenceIds).toEqual(['evidence-b']);
    expect(data.cards['card-unverified'].needsReview).toBe(true);
    expect(data.researches['research-b'].documentIds).toEqual(['paper-b']);
    expect(() => workspace.removeExcerpt('evidence-b')).toThrow(/引用/);
    expect(() => workspace.attachEvidenceToCard('card-unverified', 'missing')).toThrow(/原文/);
    expect(workspace.getState().data.cards['card-unverified'].evidenceIds).toEqual(['evidence-b']);
  });

  it('研究切换、资料库和面板模式切换保留各研究的找依据子视图', () => {
    workspace.openResearchView('research-a', 'excerpts');
    workspace.findEvidence('card-unverified');
    workspace.setPanel('ai');
    workspace.switchResearch('research-b');
    workspace.openResearchView('research-b', 'drafts');
    expect(() => workspace.findEvidence('card-unverified')).toThrow(/所在研究/);
    expect(workspace.getSession().panel.findEvidenceFor).toBeUndefined();
    workspace.openCollection('documents');
    workspace.switchResearch('research-a');
    expect(workspace.getSession().active).toEqual({ kind: 'researchView', id: 'excerpts' });
    expect(workspace.getSession().panel).toMatchObject({ mode: 'ai', findEvidenceFor: 'card-unverified' });
    expect(workspace.getState().data.sessions['research-b'].active).toEqual({ kind: 'researchView', id: 'drafts' });
  });

  it('合并无全文条目一次转移研究、白板、打开项、历史和面板引用', () => {
    workspace.updateData(data => {
      data.researches['research-b'].documentIds = ['paper-stub'];
      data.placements['stub-placement'] = { id: 'stub-placement', boardId: 'board-a', resourceRef: { kind: 'document', id: 'paper-stub' }, x: 0, y: 0, group: '' };
      const session = data.sessions['research-a'];
      session.active = { kind: 'document', id: 'paper-stub' };
      session.openItems = [{ kind: 'document', id: 'paper-stub' }, { kind: 'document', id: 'paper-a' }];
      session.history = [{ kind: 'document', id: 'paper-stub' }];
      session.recentItems = [{ kind: 'document', id: 'paper-stub' }];
      session.panel.ref = { kind: 'document', id: 'paper-stub' };
      session.panel.history = [{ kind: 'document', id: 'paper-stub' }];
      session.panel.sourceReturnRef = { kind: 'document', id: 'paper-stub' };
      session.pinnedIds = ['paper-stub'];
    });
    workspace.mergeDocuments('paper-stub', 'paper-a');
    const data = workspace.getState().data, session = data.sessions['research-a'];
    expect(data.documents['paper-stub']).toBeUndefined();
    expect(data.documents['paper-a'].identifiers?.arxiv).toBe('1706.03762');
    expect(data.researches['research-b'].documentIds).toEqual(['paper-a']);
    expect(data.researches['research-a'].documentIds.filter(id => id === 'paper-a')).toHaveLength(1);
    expect(data.placements['stub-placement'].resourceRef.id).toBe('paper-a');
    expect(session.openItems).toEqual([{ kind: 'document', id: 'paper-a' }]);
    expect([session.active, ...session.history, session.panel.ref, ...session.panel.history, session.panel.sourceReturnRef].every(ref => ref?.id === 'paper-a')).toBe(true);
    expect(session.pinnedIds).toEqual(['paper-a']);
    expect(session.recentItems).toEqual([{ kind: 'document', id: 'paper-a' }]);
    expect(() => workspace.mergeDocuments('paper-a', 'paper-b')).toThrow(/无全文/);
  });

  it('无全文条目出现异常摘录时拒绝合并，所有关联原样保留', () => {
    workspace.updateData(data => { data.evidence.broken = { id: 'broken', documentId: 'paper-stub', pageIndex: 0, quote: '异常资料' }; });
    const before = structuredClone(workspace.getState().data);
    expect(() => workspace.mergeDocuments('paper-stub', 'paper-a')).toThrow(/摘录/);
    expect(workspace.getState().data).toEqual(before);
  });

  it.each(['doi', 'arxiv', 'url'] as const)('合并遇到同类型不同 %s 标识时原子拒绝，保留两边原值', kind => {
    workspace.updateData(data => {
      data.documents['paper-stub'].identifiers = { [kind]: 'stub-value' };
      data.documents['paper-a'].identifiers = { [kind]: 'target-value' };
    });
    const before = structuredClone(workspace.getState().data);
    expect(() => workspace.mergeDocuments('paper-stub', 'paper-a')).toThrow(/标识不一致/);
    expect(workspace.getState().data).toEqual(before);
  });

  it('相同标识不阻止合并，另一侧的不同类型标识一并保留', () => {
    workspace.updateData(data => {
      data.documents['paper-a'].identifiers = { arxiv: '1706.03762', doi: '10.1000/abc' };
    });
    workspace.mergeDocuments('paper-stub', 'paper-a');
    expect(workspace.getState().data.documents['paper-a'].identifiers).toEqual({ arxiv: '1706.03762', doi: '10.1000/abc' });
  });
});
