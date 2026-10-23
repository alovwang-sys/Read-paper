import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { researchEvidence } from '../../src/domain/knowledge';
import { exportMarkdown } from '../../src/features/export/exportMarkdown';
import { createInlineConversation } from '../../src/services/inline-ai';
import { validateEvidence, workspace } from '../../src/services/workspace';
import type { InlineAISelection } from '../../src/services/inline-ai';
import type { AIRequest } from '../../src/domain/types';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn() }));
const state = () => workspace.getState().data;

beforeEach(async () => {
  vi.useFakeTimers();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('原文标记与来源证据独立保存', () => {
  it('移除已引用标记后仍保留摘录、卡片、AI 快照和导出，刷新也保留隐藏状态', async () => {
    const evidence = state().evidence['evidence-a'];
    workspace.contextFromEvidence(evidence);
    const before = structuredClone(state());
    const exported = exportMarkdown(before, 'draft-a');
    workspace.setExcerptMarked(evidence.id, false);
    expect(state().evidence[evidence.id]).toEqual({ ...before.evidence[evidence.id], annotationHidden: true });
    expect(state().cards).toEqual(before.cards);
    expect(state().conversations).toEqual(before.conversations);
    expect(state().requests).toEqual(before.requests);
    expect(researchEvidence(state(), 'research-a').map(item => item.id)).toContain(evidence.id);
    expect(validateEvidence(state(), [evidence.id])).toHaveLength(1);
    expect(exportMarkdown(state(), 'draft-a')).toBe(exported);
    await workspace.flushSave();
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)?.[0].evidence[evidence.id].annotationHidden).toBe(true);
    expect(migrateWorkspace(structuredClone(state())).evidence[evidence.id].annotationHidden).toBe(true);
  });

  it('移除时去掉已有定位高亮，保留页码；重新点击引用仍能定位', () => {
    const evidence = state().evidence['evidence-a'];
    const scope = { kind: 'research' as const, researchId: 'research-a' };
    workspace.openResource({ kind: 'document', id: evidence.documentId }, { scope, target: 'main', anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex } });
    workspace.openResource({ kind: 'document', id: evidence.documentId }, { scope, target: 'inspector', anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex } });
    workspace.setExcerptMarked(evidence.id, false);
    expect(state().sessions['research-a'].anchor).toEqual({ pageIndex: evidence.pageIndex });
    expect(state().sessions['research-a'].panel.anchor).toEqual({ pageIndex: evidence.pageIndex });
    workspace.openResource({ kind: 'document', id: evidence.documentId }, { scope, target: 'main', anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex } });
    expect(state().sessions['research-a'].anchor?.evidenceId).toBe(evidence.id);
    expect(state().evidence[evidence.id].annotationHidden).toBe(true);
  });

  it('重摘同一段落或显式恢复复用原 ID，不增加重复摘录', () => {
    const range = { documentId: 'paper-a', pageIndex: 0, quote: '可恢复标记的同一段落' };
    const id = workspace.captureExcerpt('research-a', range);
    workspace.setExcerptMarked(id, false);
    expect(workspace.captureExcerpt('research-a', range)).toBe(id);
    expect(state().evidence[id].annotationHidden).toBeUndefined();
    workspace.setExcerptMarked(id, false);
    workspace.setExcerptMarked(id, true);
    expect(state().evidence[id].annotationHidden).toBeUndefined();
    expect(Object.values(state().evidence).filter(item => item.quote === range.quote)).toHaveLength(1);
  });

  it('隐藏区域不会改变图片资产、位置或旋转，卡片复用也不擅自恢复标记', () => {
    const region = { assetId: 'region-asset', hash: 'a'.repeat(64), rect: { x: .2, y: .3, width: .4, height: .2 }, rotation: 90, width: 500, height: 250 };
    const id = workspace.createRegionEvidence({ documentId: 'paper-a', pageIndex: 0, quote: '', region });
    const cardId = workspace.createCard([id]);
    workspace.setExcerptMarked(id, false);
    workspace.associateCard('research-b', cardId);
    expect(state().evidence[id].region).toEqual(region);
    expect(state().evidence[id].annotationHidden).toBe(true);
    expect(state().cards[cardId].evidenceIds).toContain(id);
    expect(state().evidence['evidence-a'].annotationHidden).toBeUndefined();
  });

  it('即使原文旁问答未发送且本轮材料已移除，也不能硬删它的来源', () => {
    const conversationId = createInlineConversation('research-a', { documentId: 'paper-a', pageIndex: 0, quote: '尚未发送的原文旁问答' });
    const evidenceId = state().conversations[conversationId].inlineSource!.evidenceId;
    workspace.updateData(data => { data.conversations[conversationId].contextIds = []; });
    workspace.setExcerptMarked(evidenceId, false);
    expect(() => workspace.removeExcerpt(evidenceId)).toThrow(/引用/);
    expect(() => migrateWorkspace(structuredClone(state()))).not.toThrow();
  });

  it.each(['text', 'region'] as const)('纯提问%s标记移除与恢复不收藏来源，问答、草稿和另一位置均保留', async kind => {
    workspace.updateData(data => { data.documents['paper-a'].hash = 'a'.repeat(64); });
    const region = { assetId: 'question-region', hash: 'b'.repeat(64), rect: { x: .1, y: .1, width: .2, height: .2 }, rotation: 0, width: 200, height: 200 };
    const source: InlineAISelection = { documentId: 'paper-a', pageIndex: 0, quote: kind === 'text' ? 'same selected sentence' : '', kind,
      ...(kind === 'text' ? { textAnchor: { start: 10, end: 32 } } : { region }) };
    const conversationId = createInlineConversation('research-a', source);
    const otherId = createInlineConversation('research-a', { ...source, ...(kind === 'text'
      ? { textAnchor: { start: 50, end: 72 } } : { region: { ...region, rect: { ...region.rect, x: .5 } } }) });
    const evidenceId = state().conversations[conversationId].inlineSource!.evidenceId;
    const otherEvidenceId = state().conversations[otherId].inlineSource!.evidenceId;
    expect(otherEvidenceId).not.toBe(evidenceId);
    const now = new Date().toISOString(), requestId = `question-${kind}`, draftId = `draft-${kind}`;
    const request: AIRequest = { id: requestId, researchId: 'research-a', conversationId, purpose: 'chat', prompt: '已提交的局部问题', body: '已收到且保留的回答 [1]',
      context: [{ evidenceId, documentId: 'paper-a', documentHash: 'a'.repeat(64), title: state().documents['paper-a'].title, pageIndex: 0, quote: source.quote,
        ...(kind === 'region' ? { kind: 'region', region } : {}) }],
      readerOperation: 'question', readerEvidenceId: evidenceId, evidenceIds: [evidenceId], history: [], status: 'done', createdAt: now };
    workspace.updateData(data => {
      data.requests[requestId] = request;
      const conversation = data.conversations[conversationId];
      conversation.requestIds.push(requestId); conversation.input = '仍未发送的下一轮草稿'; conversation.inlineSource!.draftId = draftId;
      data.cardDrafts[draftId] = { id: draftId, researchId: 'research-a', conversationId,
        source: { researchId: 'research-a', conversationId, conversationTitle: '局部提问', requestId, prompt: request.prompt, answer: request.body,
          selection: request.body, context: structuredClone(request.context), createdAt: now, generationRequestIds: [] },
        title: '未保存卡片标题', body: '正在编辑的正文 [1]', evidenceIds: [evidenceId], needsReview: true, status: 'editing', revision: 2 };
    });
    const before = structuredClone(state()), excerpts = researchEvidence(state(), 'research-a').map(item => item.id);
    workspace.setExcerptMarked(evidenceId, false);
    expect(state().evidence[evidenceId]).toMatchObject({ contextOnly: true, annotationHidden: true });
    const refreshed = migrateWorkspace(structuredClone(state()));
    expect(refreshed.evidence[evidenceId]).toMatchObject({ contextOnly: true, annotationHidden: true });
    expect(refreshed.requests[requestId]).toEqual(before.requests[requestId]);
    workspace.setExcerptMarked(evidenceId, true);
    expect(state().evidence[evidenceId]).toEqual(before.evidence[evidenceId]);
    expect(state().evidence[evidenceId].contextOnly).toBe(true);
    expect(researchEvidence(state(), 'research-a').map(item => item.id)).toEqual(excerpts);
    expect(state().evidence[otherEvidenceId]).toEqual(before.evidence[otherEvidenceId]);
    expect(state().conversations).toEqual(before.conversations);
    expect(state().requests).toEqual(before.requests);
    expect(state().cardDrafts).toEqual(before.cardDrafts);
    expect(() => workspace.removeExcerpt(evidenceId)).toThrow(/引用/);
    await workspace.flushSave();
    const persisted = vi.mocked(saveWorkspace).mock.calls.at(-1)![0];
    expect(persisted.evidence[evidenceId]).toEqual(before.evidence[evidenceId]);
    expect(migrateWorkspace(structuredClone(persisted)).cardDrafts[draftId]).toEqual(before.cardDrafts[draftId]);
  });

  it('文稿保留的卡片引用也保护摘录不被硬删', () => {
    const id = workspace.captureExcerpt('research-a', { documentId: 'paper-a', pageIndex: 0, quote: '文稿卡片引用的原文' });
    workspace.updateData(data => { data.drafts['draft-a'].cardRefs = [{ cardId: 'card-a', insertedAt: new Date().toISOString(), evidenceIds: [id] }]; });
    expect(() => workspace.removeExcerpt(id)).toThrow(/引用/);
    workspace.setExcerptMarked(id, false);
    expect(state().evidence[id].annotationHidden).toBe(true);
  });

  it('缺失摘录和非法导入标记状态不会污染现有资料', () => {
    const before = structuredClone(state());
    expect(() => workspace.setExcerptMarked('missing', false)).toThrow(/摘录不存在/);
    expect(state()).toEqual(before);
    const invalid = structuredClone(state());
    Object.assign(invalid.evidence['evidence-a'], { annotationHidden: 'true' });
    expect(() => migrateWorkspace(invalid)).toThrow(/证据数据损坏/);
  });
});
