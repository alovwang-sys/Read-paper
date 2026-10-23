import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { validateResearchData } from '../../src/domain/research';
import { workspace } from '../../src/services/workspace';
import { removeBoardPlacements } from '../../src/services/board-structure';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { searchLiterature } from '../../src/services/literature';
import { branchBoardResearch, candidateMaterial, createBoardQuestion, findResearchEvidence, focusLiteratureCandidate, importLiteratureCandidate, openBoardResearch, placeLiteratureCandidate, researchMaterials, returnToResearchRoot, searchBoardLiterature, setResearchMaterial, stopAllLiteratureSearches, stopLiteratureSearch } from '../../src/services/board-research';
import type { LiteratureCandidate } from '../../src/domain/types';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), getAsset: vi.fn() }));
vi.mock('../../src/services/literature', () => ({ searchLiterature: vi.fn() }));
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
const paper: LiteratureCandidate = { id: 'openalex-W123', provider: 'openalex', providerId: 'W123', title: 'A real source title', authors: ['Example author'], year: 2023, doi: '10.1234/source', url: 'https://example.org/source', abstract: 'An explicitly provided source summary.', retrievedAt: '2026-10-20T00:00:00Z' };
beforeEach(async () => {
  vi.useFakeTimers(); memory.clear();
  const data = createSeed();
  Object.values(data.documents).forEach(document => { if (document.assetId) document.hash = 'a'.repeat(64); });
  data.cards['foreign-card'] = { id: 'foreign-card', title: 'Other research only', body: 'not searchable', evidenceIds: [], needsReview: true };
  data.researches['research-b'].cardIds.push('foreign-card');
  data.placements['placement-b1'] = { id: 'placement-b1', boardId: 'board-b', resourceRef: { kind: 'card', id: 'foreign-card' }, x: 50, y: 50, group: '' };
  vi.mocked(loadWorkspace).mockResolvedValue(data);
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  vi.mocked(searchLiterature).mockReset().mockResolvedValue({ candidates: [structuredClone(paper)], partial: true, warnings: ['One metadata field is missing.'] });
  await workspace.load();
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); });
function open(boardId = 'board-a', placementId = 'placement-a') {
  return openBoardResearch({ boardId, placementIds: [placementId], mode: 'ask' }).conversationId;
}

describe('白板局部研究共享服务', () => {
  it('摆放仍指向已删除讨论时新开讨论，不复用墓碑；原请求、卡片与原文引用保留', () => {
    const id = open();
    workspace.updateData(next => {
      const evidence = next.evidence['evidence-a'], document = next.documents[evidence.documentId];
      next.requests['deleted-board-answer'] = { id: 'deleted-board-answer', researchId: 'research-a', conversationId: id,
        prompt: '旧讨论中已核对的问题', body: '带原文依据的旧回答 [1]', purpose: 'chat', status: 'done',
        createdAt: '2026-10-23T00:00:00.000Z', evidenceIds: [evidence.id],
        context: [{ evidenceId: evidence.id, documentId: document.id, documentHash: document.hash!, title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote }] };
      next.conversations[id].requestIds = ['deleted-board-answer'];
      next.conversations[id].input = '留在回收站中的旧草稿';
      next.placements['placement-a'].researchConversationId = id;
    });
    workspace.deleteConversation(id);
    const deleted = structuredClone(workspace.getState().data.conversations[id]);
    const request = structuredClone(workspace.getState().data.requests['deleted-board-answer']);
    const card = structuredClone(workspace.getState().data.cards['card-a']);
    const evidence = structuredClone(workspace.getState().data.evidence);
    expect(workspace.getState().data.placements['placement-a'].researchConversationId).toBe(id);

    const replacement = open();
    const next = workspace.getState().data;
    expect(replacement).not.toBe(id);
    expect(next.sessions['research-a'].activeConversationId).toBe(replacement);
    expect(next.conversations[replacement]).toMatchObject({ requestIds: [], input: '', boardResearch: { origin: { boardId: 'board-a', rootPlacementId: 'placement-a' } } });
    expect(next.conversations[replacement].deletedAt).toBeUndefined();
    expect(next.conversations[id]).toEqual(deleted);
    expect(next.requests['deleted-board-answer']).toEqual(request);
    expect(next.cards['card-a']).toEqual(card);
    expect(next.evidence).toEqual(evidence);
    expect(() => validateResearchData(next)).not.toThrow();
  });

  it('按摆放复用探索，显式提问才更换焦点；不会把卡片引用自动加入原文', () => {
    const id = open();
    const before = workspace.getState().data.conversations[id];
    expect(before.contextIds).toEqual([]);
    expect(before.historyRange).toBe('guided');
    expect(researchMaterials(workspace.getState().data, id).map(item => item.kind)).toEqual(['background', 'card_note']);
    expect(open()).toBe(id);
    expect(() => openBoardResearch({ boardId: 'board-b', placementIds: ['placement-a'], mode: 'ask' })).toThrow(/改变/);
    expect(workspace.getState().data.conversations[id].boardResearch?.focus).toEqual(before.boardResearch?.focus);
  });
  it('问题卡、研究关联、摆放原子创建，绘图来路和草稿恢复可持久化', () => {
    const result = createBoardQuestion({ boardId: 'board-a', title: 'A new question', body: 'A narrow concern', drawingOrigin: { elementIds: ['drawing-text'], text: 'A narrow concern' } });
    const data = workspace.getState().data;
    expect(data.researches['research-a'].cardIds).toContain(result.cardId);
    expect(data.placements[result.placementId].resourceRef.id).toBe(result.cardId);
    expect(data.cards[result.cardId].drawingOrigin?.elementIds).toEqual(['drawing-text']);
    expect(migrateWorkspace(data).cards[result.cardId].drawingOrigin?.text).toBe('A narrow concern');
    const count = Object.keys(data.cards).length;
    expect(() => createBoardQuestion({ boardId: 'board-a', title: '', body: 'bad' })).toThrow();
    expect(Object.keys(workspace.getState().data.cards)).toHaveLength(count);
  });
  it('焦点自动替换，主动保留持续携带；取消后不会自动绕回正文', () => {
    const id = open();
    focusLiteratureCandidate(id, paper);
    expect(researchMaterials(workspace.getState().data, id).some(item => item.id === paper.id)).toBe(true);
    returnToResearchRoot(id);
    expect(researchMaterials(workspace.getState().data, id).some(item => item.id === paper.id)).toBe(false);
    setResearchMaterial(id, candidateMaterial(paper), true);
    returnToResearchRoot(id);
    expect(researchMaterials(workspace.getState().data, id).some(item => item.id === paper.id)).toBe(true);
    setResearchMaterial(id, candidateMaterial(paper), false);
    expect(workspace.getState().data.conversations[id].boardResearch?.pinned.some(item => item.id === paper.id)).toBe(true);
    focusLiteratureCandidate(id, paper);
    expect(researchMaterials(workspace.getState().data, id).some(item => item.id === paper.id)).toBe(false);
    const items = researchMaterials(workspace.getState().data, id);
    items.forEach(item => setResearchMaterial(id, item, false));
    expect(researchMaterials(workspace.getState().data, id)).toEqual([]);
  });
  it('取消背景与根卡后，原问题正文不经定位元字段发送；新轮读取共享正文新版本', () => {
    const id = open();
    const first = researchMaterials(workspace.getState().data, id);
    const card = first.find(item => item.kind === 'card_note')!;
    workspace.updateData(data => { data.cards[card.resourceRef!.id].body = 'Updated shared body'; });
    expect(researchMaterials(workspace.getState().data, id).find(item => item.kind === 'card_note')?.text).toBe('Updated shared body');
    expect(first.find(item => item.kind === 'card_note')?.text).not.toBe('Updated shared body');
    first.forEach(item => setResearchMaterial(id, item, false));
    const conversation = workspace.getState().data.conversations[id];
    expect(JSON.stringify(conversation.boardResearch?.origin)).not.toContain('Updated shared body');
    expect(researchMaterials(workspace.getState().data, id)).toEqual([]);
  });
  it('独立找依据冻结应用扫描与候选，不自动加入问答；范围外的证据不可查', () => {
    const id = open();
    const data = workspace.getState().data;
    const old = structuredClone(data.conversations[id]);
    const batchId = findResearchEvidence(id, 'research', '');
    const next = workspace.getState().data.conversations[id];
    expect(next.contextIds).toEqual(old.contextIds);
    expect(next.boardResearch).toEqual(old.boardResearch);
    const batch = next.evidenceSearches!.find(item => item.id === batchId)!;
    expect(batch.scannedIds).not.toContain('card:foreign-card');
    expect(batch.candidates.length).toBeGreaterThan(0);
    const frozen = JSON.stringify(batch);
    workspace.updateData(state => { state.cards['card-a'].body = 'changed after lookup'; });
    expect(JSON.stringify(workspace.getState().data.conversations[id].evidenceSearches!.find(item => item.id === batchId))).toBe(frozen);
  });
  it('异步搜索绑定原研究/问题；入库、加入讨论、摆放分别生效且去重', async () => {
    const a = open();
    let release!: (value: { candidates: LiteratureCandidate[] }) => void;
    vi.mocked(searchLiterature).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = searchBoardLiterature(a, 'test query');
    const b = open('board-b', 'placement-b1');
    release({ candidates: [structuredClone(paper)] });
    const batchId = await pending;
    let data = workspace.getState().data;
    expect(data.conversations[b].literatureSearches).toBeUndefined();
    expect(data.conversations[a].literatureSearches![0].query).toBe('test query');
    const before = researchMaterials(data, a);
    const docId = importLiteratureCandidate(a, batchId, paper.id);
    expect(importLiteratureCandidate(a, batchId, paper.id)).toBe(docId);
    expect(researchMaterials(workspace.getState().data, a)).toEqual(before);
    const placementId = placeLiteratureCandidate(a, batchId, paper.id);
    expect(placeLiteratureCandidate(a, batchId, paper.id)).toBe(placementId);
    expect(openBoardResearch({ boardId: 'board-a', placementIds: [placementId], mode: 'ask' }).conversationId).toBe(a);
    data = workspace.getState().data;
    const placed = data.placements[placementId];
    expect(Object.values(data.placements).filter(p => p.id !== placementId && p.boardId === placed.boardId).some(p => Math.abs(p.x - placed.x) < 280 && Math.abs(p.y - placed.y) < 240)).toBe(false);
    expect(data.conversations[a].boardResearch?.origin.rootPlacementId).toBe('placement-a');
    expect(data.researches['research-b'].documentIds).not.toContain(docId);
    expect(Object.values(data.edges).find(edge => edge.toPlacementId === placementId)?.fromPlacementId).toBe('placement-a');
    expect(() => validateResearchData(data)).not.toThrow();
  });
  it('年份随批次冻结，关闭时等待所有在途检索完成取消与状态保存', async () => {
    const a = open(), b = open('board-b', 'placement-b1');
    const batchId = await searchBoardLiterature(a, 'year filter', { yearFrom: 2020, yearTo: 2024 });
    expect(vi.mocked(searchLiterature).mock.calls[0][1]).toMatchObject({ yearFrom: 2020, yearTo: 2024 });
    expect(workspace.getState().data.conversations[a].literatureSearches!.find(batch => batch.id === batchId)).toMatchObject({ yearFrom: 2020, yearTo: 2024 });
    vi.mocked(searchLiterature).mockImplementation((_query, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = [searchBoardLiterature(a, 'close A'), searchBoardLiterature(b, 'close B')];
    await stopAllLiteratureSearches();
    await Promise.all(pending);
    const state = workspace.getState().data;
    expect(state.conversations[a].literatureSearches!.at(-1)?.status).toBe('stopped');
    expect(state.conversations[b].literatureSearches!.at(-1)?.status).toBe('stopped');
    await expect(searchBoardLiterature(a, 'invalid years', { yearFrom: 2025, yearTo: 2020 })).rejects.toThrow(/年份/);
  });
  it('保存搜索缺字段提示，重载中断检索；取消能终止请求', async () => {
    const id = open();
    await searchBoardLiterature(id, 'warnings');
    const batch = workspace.getState().data.conversations[id].literatureSearches![0];
    expect(batch.partial).toBe(true); expect(batch.warnings).toHaveLength(1);
    vi.mocked(searchLiterature).mockImplementationOnce((_query, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const pending = searchBoardLiterature(id, 'cancel');
    const active = workspace.getState().data.conversations[id].literatureSearches!.at(-1)!;
    const restored = migrateWorkspace(workspace.getState().data);
    expect(restored.conversations[id].literatureSearches!.at(-1)?.status).toBe('interrupted');
    stopLiteratureSearch(active.id);
    await pending;
    expect(workspace.getState().data.conversations[id].literatureSearches!.at(-1)?.status).toBe('stopped');
  });
  it('原问题移出后保留候选，拒绝错误摆放；干净分支不复制历史或原生身份', async () => {
    const id = open();
    const batchId = await searchBoardLiterature(id, 'test');
    workspace.updateData(data => {
      data.conversations[id].nativeSessionId = 'old-native';
      data.conversations[id].nativeSessionRef = 'old-ref';
      data.conversations[id].input = 'keep this input';
    });
    removeBoardPlacements('board-a', ['placement-a']);
    const branch = branchBoardResearch(id);
    const next = workspace.getState().data.conversations[branch];
    expect(next.requestIds).toEqual([]); expect(next.nativeSessionId).toBeUndefined(); expect(next.input).toBe('keep this input');
    expect(() => placeLiteratureCandidate(id, batchId, paper.id)).toThrow(/摆放已缺失/);
    expect(workspace.getState().data.conversations[id].literatureSearches![0].candidates).toHaveLength(1);
  });
});
