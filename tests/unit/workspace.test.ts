import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { linkCard, scopeKey, workspace } from '../../src/services/workspace';
import {
  appendAIToDraft,
  snapshotContext,
  submitAI,
  validateResponse,
} from '../../src/services/ai';
import type { AIRequest } from '../../src/domain/types';
import { getAsset, loadWorkspace, saveWorkspace } from '../../src/data/storage';

vi.mock('../../src/data/storage', () => ({
  loadWorkspace: vi.fn(),
  saveWorkspace: vi.fn(),
  getAsset: vi.fn(),
}));
const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
  removeItem: (key: string) => memory.delete(key),
});

beforeEach(async () => {
  vi.useFakeTimers();
  memory.clear();
  vi.mocked(saveWorkspace).mockReset().mockResolvedValue(undefined);
  vi.mocked(getAsset)
    .mockReset()
    .mockResolvedValue(new Blob(['test asset']));
  const data = createSeed();
  Object.values(data.documents).forEach((doc) => {
    doc.hash = 'a'.repeat(64);
  });
  vi.mocked(loadWorkspace).mockReset().mockResolvedValue(data);
  await workspace.load();
});
afterEach(async () => {
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

describe('工作台共享实体与会话', () => {
  it('关闭前等待进行中的保存，并保存等待期间的最新修改', async () => {
    let finish!: () => void;
    vi.mocked(saveWorkspace).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    workspace.updateData(data => { data.cards['card-a'].body = '第一份快照'; });
    workspace.retrySave();
    workspace.updateData(data => { data.cards['card-a'].body = '关闭前的最后修改'; });
    let complete = false;
    const flush = workspace.flushSave().then(() => { complete = true; });
    await Promise.resolve();
    expect(complete).toBe(false);
    finish();
    await flush;
    expect(vi.mocked(saveWorkspace).mock.calls.at(-1)?.[0].cards['card-a'].body).toBe('关闭前的最后修改');
    expect(workspace.getState().saveStatus).toBe('saved');
  });
  it('大记录保存失败时关闭等待失败，原编辑保留且能够重试', async () => {
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('quota error'));
    workspace.updateData(data => { data.cards['card-a'].body = '待保存'.repeat(600_000); });
    await expect(workspace.flushSave()).rejects.toThrow(/quota error/);
    expect(workspace.getState().data.cards['card-a'].body.length).toBe(1_800_000);
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    await workspace.flushSave();
    expect(workspace.getState().saveStatus).toBe('saved');
  });
  it('关联已有卡片同时关联证据论文，资料正文保持唯一', () => {
    workspace.associateCard('research-b', 'card-a');
    let data = workspace.getState().data;
    expect(data.researches['research-b'].cardIds).toEqual(['card-a']);
    expect(data.researches['research-b'].documentIds).toEqual(['paper-a']);
    const placement = workspace.addPlacement('board-b', {
      kind: 'card',
      id: 'card-a',
    });
    workspace.updateData((data) => {
      data.cards['card-a'].body = '共享修改';
      delete data.placements[placement.id];
    });
    data = workspace.getState().data;
    expect(data.cards['card-a'].body).toBe('共享修改');
    expect(data.placements['placement-a2'].resourceRef.id).toBe('card-a');
    expect(data.researches['research-b'].cardIds).toContain('card-a');
  });
  it('阻止无效引用污染研究关联', () => {
    const data = createSeed();
    delete data.evidence['evidence-a'];
    expect(() => linkCard(data, 'research-b', 'card-a')).toThrow(/引用/);
    expect(data.researches['research-b'].cardIds).toEqual([]);
  });
  it('打开资源去重，右侧不替换主区，按研究恢复阅读和面板', () => {
    const scope = { kind: 'research' as const, researchId: 'research-a' };
    workspace.openResource(
      { kind: 'document', id: 'paper-a' },
      { scope, target: 'main' },
    );
    workspace.openResource(
      { kind: 'document', id: 'paper-a' },
      { scope, target: 'main' },
    );
    workspace.setReader('paper-a', { pageIndex: 2, scale: 1.5 });
    workspace.openResource(
      { kind: 'card', id: 'card-a' },
      { scope, target: 'inspector' },
    );
    workspace.setPanel('ai');
    workspace.switchResearch('research-b');
    workspace.setPanel('info');
    workspace.switchResearch('research-a');
    const session = workspace.getSession();
    expect(
      session.openItems.filter((ref) => ref.id === 'paper-a'),
    ).toHaveLength(1);
    expect(session.active).toEqual({ kind: 'document', id: 'paper-a' });
    expect(session.readers['main:paper-a']).toEqual({
      pageIndex: 2,
      scale: 1.5,
    });
    expect(session.panel.mode).toBe('ai');
    expect(session.panel.ref?.id).toBe('card-a');
    workspace.openCollection('cards');
    expect(scopeKey(workspace.getState().data.scope)).toBe('library');
    workspace.switchResearch('research-a');
    expect(workspace.getSession().active.id).toBe('paper-a');
  });
  it('来源页索引不合法时拒绝建立证据', () => {
    expect(() =>
      workspace.createEvidence({
        documentId: 'paper-a',
        pageIndex: 3,
        quote: 'invalid',
      }),
    ).toThrow(/页码/);
    expect(() =>
      workspace.createEvidence({
        documentId: 'paper-a',
        pageIndex: 0,
        quote: ' ',
      }),
    ).toThrow(/引用/);
  });
  it('读取失败时禁止写回样例，重试读取后恢复', async () => {
    vi.mocked(loadWorkspace).mockRejectedValueOnce(
      new Error('storage read failure'),
    );
    await workspace.load();
    workspace.retrySave();
    expect(workspace.getState().loadError).toContain('storage read failure');
    expect(() => workspace.createResearch('新研究', '')).toThrow(/加载/);
    expect(saveWorkspace).not.toHaveBeenCalled();
    await workspace.load();
    expect(workspace.getState().loadError).toBeUndefined();
  });
  it('保存失败后切研究、关闭项不丢缓冲，重载恢复并可重试保存', async () => {
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('quota error'));
    workspace.updateData((data) => {
      data.cards['card-a'].body = '未保存但应恢复';
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(workspace.getState().saveStatus).toBe('error');
    workspace.closeResource({ kind: 'research', id: 'research-a' });
    workspace.switchResearch('research-b');
    await workspace.load();
    expect(workspace.getState().data.cards['card-a'].body).toBe(
      '未保存但应恢复',
    );
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    workspace.retrySave();
    await vi.advanceTimersByTimeAsync(400);
    expect(workspace.getState().saveStatus).toBe('saved');
  });
});

describe('AI 上下文快照与引用', () => {
  const context = () =>
    workspace.addContext({
      researchId: 'research-a',
      conversationId: 'conversation-research-a',
      evidenceIds: ['evidence-b'],
    });
  it('选区不扩大上下文，拒绝跨研究和未关联证据', () => {
    context();
    workspace.setSelection({
      scope: { kind: 'research', researchId: 'research-a' },
      viewInstanceId: 'reader',
      selectedItems: [],
      evidenceIds: ['evidence-c'],
    });
    expect(
      snapshotContext(
        workspace.getState().data,
        'research-a',
        'conversation-research-a',
      ).map((e) => e.evidenceId),
    ).toEqual(['evidence-b']);
    expect(() =>
      workspace.addContext({
        researchId: 'research-b',
        conversationId: 'conversation-research-b',
        evidenceIds: ['evidence-b'],
      }),
    ).toThrow(/研究/);
  });
  it('迟到结果仍归提交研究，发送快照不随之后上下文变化', async () => {
    context();
    let finish!: (value: { body: string; evidenceIds: string[] }) => void;
    let submitted!: AIRequest;
    const pending = submitAI(
      'research-a',
      'conversation-research-a',
      '比较条件',
      (request) => {
        submitted = request;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    workspace.addContext({
      researchId: 'research-a',
      conversationId: 'conversation-research-a',
      evidenceIds: ['evidence-a'],
    });
    workspace.switchResearch('research-b');
    expect(submitted.context.map((e) => e.evidenceId)).toEqual(['evidence-b']);
    finish({ body: '有条件支持 [1]', evidenceIds: ['evidence-b'] });
    const id = await pending;
    expect(workspace.getState().data.scope).toEqual({
      kind: 'research',
      researchId: 'research-b',
    });
    expect(workspace.getState().data.requests[id].researchId).toBe(
      'research-a',
    );
    expect(
      workspace.getState().data.conversations['conversation-research-b']
        .requestIds,
    ).toEqual([]);
  });
  it('阻止上下文以外引用，失败可另行重试', async () => {
    context();
    const id = await submitAI(
      'research-a',
      'conversation-research-a',
      '问题',
      async () => ({ body: '越界', evidenceIds: ['evidence-a'] }),
    );
    expect(workspace.getState().data.requests[id].status).toBe('error');
    const retry = await submitAI(
      'research-a',
      'conversation-research-a',
      '问题',
      async () => ({ body: '正确 [1]', evidenceIds: ['evidence-b'] }),
    );
    expect(workspace.getState().data.requests[retry].status).toBe('done');
  });
  it('回答正文编号超出结构化引用时拒绝草稿', async () => {
    context();
    const id = await submitAI(
      'research-a',
      'conversation-research-a',
      '问题',
      async () => ({ body: '无效编号 [2]', evidenceIds: ['evidence-b'] }),
    );
    expect(workspace.getState().data.requests[id].status).toBe('error');
    expect(workspace.getState().data.requests[id].error).toContain('引用 [2]');
  });
  it('拒绝缺失或版本改变来源，限制上下文大小', () => {
    context();
    const data = structuredClone(workspace.getState().data);
    const request = {
      body: '',
      context: snapshotContext(data, 'research-a', 'conversation-research-a'),
    } as AIRequest;
    data.documents['paper-b'].hash = 'different';
    expect(() => validateResponse(data, request, ['evidence-b'])).toThrow(
      /变化/,
    );
    data.evidence['evidence-b'].quote = 'x'.repeat(24001);
    expect(() =>
      snapshotContext(data, 'research-a', 'conversation-research-a'),
    ).toThrow(/过大/);
  });
  it('原PDF资产缺失时不发送请求', async () => {
    context();
    vi.mocked(getAsset).mockResolvedValue(undefined);
    const responder = vi.fn();
    await expect(
      submitAI('research-a', 'conversation-research-a', '问题', responder),
    ).rejects.toThrow(/文件缺失/);
    expect(responder).not.toHaveBeenCalled();
  });
  it('追加单独的第二来源时重映射局部编号，保留结论原文', () => {
    context();
    const data = structuredClone(workspace.getState().data);
    const request = {
      researchId: 'research-a',
      context: snapshotContext(data, 'research-a', 'conversation-research-a'),
      body: '依据第二论文 [1]',
      evidenceIds: ['evidence-b'],
    } as AIRequest;
    const before = data.drafts['draft-a'].body;
    appendAIToDraft(data, 'draft-a', request);
    expect(data.drafts['draft-a'].body).toBe(`${before}\n\n依据第二论文 [2]`);
    expect(() => appendAIToDraft(data, 'draft-b', request)).toThrow(/研究/);
  });
});
