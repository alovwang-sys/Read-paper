import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { contentHash } from '../../src/data/storage';
import { hasFullText } from '../../src/domain/knowledge';
import type { ResearchLiteratureSearch } from '../../src/domain/research-agent';
import type { WorkspaceData } from '../../src/domain/types';
import { createWorkspaceBackup, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';

const researchId = 'research-a', conversationId = 'conversation-research-a', requestId = 'research-request';
const completed: ResearchLiteratureSearch = {
  id: 'search-completed', query: 'adaptive retrieval', yearFrom: 2020, yearTo: 2026, createdAt: '2026-10-21T12:00:00.000Z', status: 'done',
  candidates: [{ id: 'openalex-W1', provider: 'openalex', providerId: 'W1', title: 'A discovered paper', authors: ['A. Researcher'], year: 2025,
    doi: '10.1000/research', url: 'https://openalex.org/W1', abstract: 'The original abstract.', pdfUrl: 'https://example.org/paper.pdf', retrievedAt: '2026-10-21T12:00:01.000Z' }],
  partial: true, warnings: ['部分题录缺少摘要'],
};
const pending: ResearchLiteratureSearch = { id: 'search-pending', query: 'reliability', createdAt: '2026-10-21T12:01:00.000Z', status: 'searching', candidates: [] };
function seed(): WorkspaceData {
  const data = createSeed();
  data.agentWorkbench = true;
  data.conversations[conversationId].connectionId = 'codex';
  data.conversations[conversationId].input = '下一条尚未发送的草稿';
  data.conversations[conversationId].requestIds = [requestId];
  data.requests[requestId] = { id: requestId, researchId, conversationId, connectionId: 'codex', purpose: 'chat', prompt: '找出相关论文', body: '已检索到相关候选。',
    createdAt: '2026-10-21T12:00:00.000Z', status: 'generating', context: [], evidenceIds: [], history: [],
    researchRun: { literatureSearches: [structuredClone(completed), structuredClone(pending)] } };
  return data;
}
async function fixture() {
  const data = seed(), assets: BackupAsset[] = [];
  for (const doc of Object.values(data.documents).filter(hasFullText)) {
    const blob = new Blob([`%PDF-1.7\n${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer()); assets.push({ id: doc.assetId, blob });
  }
  return { data, assets };
}
async function editWorkspace(blob: Blob, edit: (data: WorkspaceData) => void) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const data: WorkspaceData = JSON.parse(strFromU8(files['workspace.json'])); edit(data);
  files['workspace.json'] = strToU8(JSON.stringify(data));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  manifest.workspace.size = files['workspace.json'].length;
  manifest.workspace.hash = await contentHash(files['workspace.json'].buffer as ArrayBuffer);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}

describe('Agent 文献检索快照的刷新和备份', () => {
  it('刷新只终止尚在检索的批次，已完成候选、原查询和下一条草稿完整保留', () => {
    const original = seed(), before = structuredClone(original), restored = migrateWorkspace(original);
    expect(original).toEqual(before);
    expect(restored.requests[requestId].status).toBe('interrupted');
    const searches = restored.requests[requestId].researchRun!.literatureSearches!;
    expect(searches[0]).toEqual(completed);
    expect(searches[1]).toMatchObject({ ...pending, status: 'interrupted' }); expect(searches[1].error).toContain('中断');
    expect(restored.requests[requestId]).toMatchObject({ researchId, conversationId, prompt: '找出相关论文', body: '已检索到相关候选。' });
    expect(restored.conversations[conversationId].input).toBe('下一条尚未发送的草稿');
  });
  it('旧工作区缺少检索快照仍能加载，损坏候选或超限批次明确拒绝', () => {
    const legacy = seed(); delete legacy.requests[requestId].researchRun!.literatureSearches;
    expect(migrateWorkspace(legacy).requests[requestId].researchRun?.literatureSearches).toBeUndefined();
    for (const breakSnapshot of [
      (data: WorkspaceData) => { data.requests[requestId].researchRun!.literatureSearches![0].candidates[0].url = 'javascript:alert(1)'; },
      (data: WorkspaceData) => { data.requests[requestId].researchRun!.literatureSearches![0].query = 'x'.repeat(501); },
      (data: WorkspaceData) => { data.requests[requestId].researchRun!.literatureSearches!.push(structuredClone(pending), structuredClone(pending)); },
    ]) {
      const broken = seed(); breakSnapshot(broken);
      expect(() => migrateWorkspace(broken)).toThrow(/文献/);
    }
  });
  it('ZIP 往返保留完整候选、摘要、警告、错误及研究会话归属，不触碰原数据', async () => {
    const { data, assets } = await fixture(); data.requests[requestId].status = 'stopped';
    Object.assign(data.requests[requestId].researchRun!.literatureSearches![1], { status: 'stopped', error: '用户停止本轮检索', errorCode: 'stopped' });
    const before = structuredClone(data), blob = await createWorkspaceBackup(data, assets), restored = await readWorkspaceBackup(blob);
    expect(data).toEqual(before);
    expect(restored.data.requests[requestId].researchRun!.literatureSearches).toEqual(data.requests[requestId].researchRun!.literatureSearches);
    expect(restored.data.requests[requestId]).toMatchObject({ researchId, conversationId, status: 'stopped' });
    expect(restored.data.conversations[conversationId].input).toBe('下一条尚未发送的草稿');
    expect(restored.assets).toHaveLength(assets.length);
  });
  it('正在检索的生成不能直接导出；恢复带悬挂检索的合法归档时明确标中断', async () => {
    const { data, assets } = await fixture();
    await expect(createWorkspaceBackup(data, assets)).rejects.toThrow(/停止/);
    data.requests[requestId].status = 'error';
    const blob = await createWorkspaceBackup(data, assets), restored = await readWorkspaceBackup(blob);
    expect(restored.data.requests[requestId].researchRun!.literatureSearches![0]).toEqual(completed);
    expect(restored.data.requests[requestId].researchRun!.literatureSearches![1].status).toBe('interrupted');
  });
  it('即使 ZIP 清单校验和正确，也拒绝语义损坏的检索候选', async () => {
    const { data, assets } = await fixture(); data.requests[requestId].status = 'stopped';
    data.requests[requestId].researchRun!.literatureSearches![1].status = 'stopped';
    const blob = await createWorkspaceBackup(data, assets);
    const corrupted = await editWorkspace(blob, current => { current.requests[requestId].researchRun!.literatureSearches![0].candidates[0].abstract = 'x'.repeat(100001); });
    await expect(readWorkspaceBackup(corrupted)).rejects.toThrow(/文献|摘要/);
  });
});
