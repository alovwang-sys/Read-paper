import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { loadWorkspace, saveWorkspace } from '../../src/data/storage';
import { migrateWorkspace } from '../../src/data/migrations';
import { workspace } from '../../src/services/workspace';
import { attachPdf } from '../../src/services/pdf';
import { acquireFullText, collectSource, extractSourceLinks, sourceCandidate } from '../../src/services/sources';

vi.mock('../../src/data/storage', () => ({ loadWorkspace: vi.fn(), saveWorkspace: vi.fn(), saveMigrationBackup: vi.fn(), restoreWorkspaceBackup: vi.fn() }));
vi.mock('../../src/services/pdf', () => ({ attachPdf: vi.fn() }));
const scope = { kind: 'research', researchId: 'research-a' } as const;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value), removeItem: (key: string) => memory.delete(key) });
  vi.mocked(loadWorkspace).mockResolvedValue(createSeed());
  vi.mocked(saveWorkspace).mockResolvedValue(undefined);
  await workspace.load();
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(json({ error: '全文需要登录' }, 403))));
});
afterEach(async () => { await vi.runOnlyPendingTimersAsync(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('来源收录', () => {
  it('只识别真实链接与标识，保留标题、去重，并忽略代码和搜索导航', () => {
    const links = extractSourceLinks('[注意力论文](https://arxiv.org/abs/1706.03762v7)\nhttps://arxiv.org/pdf/1706.03762.pdf\nDOI:10.1000/abc\n[搜索](https://www.google.com/search?q=paper)\n`https://example.org/code`\n```\nhttps://example.org/script\n```');
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ title: '注意力论文', kind: 'paper', identifiers: { arxiv: '1706.03762' } });
    expect(links[0].url).toBe('https://arxiv.org/abs/1706.03762v7');
    expect(links[0].identifiers?.url).toBe(links[0].url);
    expect(links[1].identifiers?.doi).toBe('10.1000/abc');
    expect(() => sourceCandidate('javascript:alert(1)')).toThrow();
    expect(() => sourceCandidate('https://user:password@example.org/paper')).toThrow();
  });

  it('预览不会入库，关闭恢复原任务，右侧AI与输入保持原样', () => {
    const before = structuredClone(workspace.getState().data);
    workspace.openSourcePreview(sourceCandidate('https://example.org/paper', '候选论文'), scope);
    expect(workspace.getState().data.documents).toEqual(before.documents);
    expect(workspace.getSession(scope).active).toEqual(before.sessions['research-a'].active);
    expect(workspace.getSession(scope).panel).toEqual(before.sessions['research-a'].panel);
    workspace.back('main');
    expect(workspace.getSession(scope).sourcePreview).toBeUndefined();
    expect(workspace.getSession(scope).active).toEqual(before.sessions['research-a'].active);
  });

  it('元数据不可获取仍保存原链接，重复加入跨研究复用实体并独立保留发现与备注', async () => {
    const candidate = sourceCandidate('https://example.org/article', '研究线索');
    const first = await collectSource(candidate, scope, { url: candidate.url, kind: 'ai', requestId: 'turn-a', createdAt: '2026-10-17T00:00:00Z' });
    await acquireFullText(first);
    const active = workspace.getSession(scope).active;
    workspace.updateData(data => { data.researches['research-a'].sourceRecords![first].note = '对研究A有用'; });
    const second = await collectSource(candidate, { kind: 'research', researchId: 'research-b' }, { url: candidate.url, kind: 'ai', requestId: 'turn-b', createdAt: '2026-10-17T00:00:00Z' });
    await acquireFullText(second);
    expect(first).toBe(second);
    const data = workspace.getState().data;
    expect(data.documents[first]).toMatchObject({ title: '研究线索', acquisition: { status: 'error', message: '全文需要登录' } });
    expect(data.researches['research-a'].sourceRecords![first]).toMatchObject({ note: '对研究A有用', discoveries: [{ requestId: 'turn-a' }] });
    expect(data.researches['research-b'].sourceRecords![first]).toMatchObject({ note: '', discoveries: [{ requestId: 'turn-b' }] });
    expect(workspace.getSession(scope).active).toEqual(active);
    expect(vi.mocked(saveWorkspace).mock.calls.some(([saved]) => saved.documents[first])).toBe(true);
  });

  it('全文下载失败保留可核对的原摘要，且迟到元数据不覆盖人工编辑', async () => {
    const candidate = sourceCandidate('https://doi.org/10.1000/late', '回答中的标题');
    const metadata = deferred<Response>();
    vi.mocked(fetch).mockImplementation(url => String(url).endsWith('/resolve') ? metadata.promise : Promise.resolve(json({ error: '返回的是登录页面' }, 422)));
    const id = await collectSource(candidate, scope);
    workspace.updateData(data => { data.documents[id].title = '人工修正标题'; data.documents[id].authors = '人工作者'; });
    metadata.resolve(json({ ...candidate, title: '抓取的标题', authors: '抓取作者', metadataSource: candidate.url, abstract: { text: '作者原摘要', url: candidate.url, retrievedAt: '2026-10-17T00:00:00Z' }, pdfUrl: 'https://example.org/full.pdf', resolvedAt: '2026-10-17T00:00:00Z' }));
    await acquireFullText(id);
    expect(workspace.getState().data.documents[id]).toMatchObject({ title: '人工修正标题', authors: '人工作者', abstract: { text: '作者原摘要', url: candidate.url }, acquisition: { status: 'error', message: '返回的是登录页面' } });
    expect(attachPdf).not.toHaveBeenCalled();
  });

  it('手动补齐后迟到下载不替换PDF，切换研究不改变获取归属', async () => {
    const candidate = sourceCandidate('https://doi.org/10.1000/manual');
    const download = deferred<Response>();
    vi.mocked(fetch).mockImplementation(url => String(url).endsWith('/resolve') ? Promise.resolve(json({ ...candidate, pdfUrl: 'https://example.org/full.pdf' })) : download.promise);
    const id = await collectSource(candidate, scope);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/sources/pdf', expect.anything()));
    workspace.updateData(data => { Object.assign(data.documents[id], { filename: 'manual.pdf', assetId: 'manual', hash: 'manual-hash', pageCount: 1 }); data.documents[id].acquisition = undefined; });
    workspace.openResearchView('research-b', 'sources');
    download.resolve(new Response('%PDF-1.4\n'));
    await acquireFullText(id);
    expect(attachPdf).not.toHaveBeenCalled();
    expect(workspace.getState().data.documents[id].assetId).toBe('manual');
    expect(workspace.getState().data.researches['research-b'].documentIds).not.toContain(id);
  });

  it('持久化失败会拒绝收录回执，不启动下载；重试仍复用同一条资料', async () => {
    vi.mocked(saveWorkspace).mockRejectedValue(new Error('配额不足'));
    const candidate = sourceCandidate('https://example.org/retry');
    await expect(collectSource(candidate, scope)).rejects.toThrow(/配额/);
    expect(fetch).not.toHaveBeenCalled();
    const id = Object.values(workspace.getState().data.documents).find(doc => doc.identifiers?.url === candidate.url)!.id;
    vi.mocked(saveWorkspace).mockResolvedValue(undefined);
    expect(await collectSource(candidate, scope)).toBe(id);
    await acquireFullText(id);
    expect(Object.values(workspace.getState().data.documents).filter(doc => doc.identifiers?.url === candidate.url)).toHaveLength(1);
  });

  it('合并保留各研究的收录备注与发现记录，刷新将获取中转为可重试中断', () => {
    const { documentId: id } = workspace.addSource({ kind: 'identifier', raw: 'https://example.org/merge' }, scope);
    workspace.updateData(data => {
      data.researches['research-a'].sourceRecords = { [id]: { note: '候选备注', discoveries: [{ url: 'https://example.org/merge', kind: 'ai', requestId: 'turn-a', createdAt: '2026-10-17T00:00:00Z' }] }, 'paper-a': { note: '已有备注', discoveries: [] } };
      data.documents[id].acquisition = { status: 'fetching' };
    });
    expect(migrateWorkspace(workspace.getState().data).documents[id].acquisition).toMatchObject({ status: 'unavailable', message: expect.stringContaining('中断') });
    workspace.mergeDocuments(id, 'paper-a');
    const data = workspace.getState().data;
    expect(data.researches['research-a'].sourceRecords?.['paper-a']).toMatchObject({ note: '已有备注\n\n候选备注', discoveries: [{ requestId: 'turn-a' }] });
    expect(data.researches['research-a'].sourceRecords?.[id]).toBeUndefined();
    expect(migrateWorkspace(data).researches['research-a'].sourceRecords).toEqual(data.researches['research-a'].sourceRecords);
  });

  it('重试采用这次解析的新PDF地址，规范化arXiv标识而保留指定文件版本', async () => {
    const candidate = sourceCandidate('arxiv:1706.03762v7');
    const { documentId: id } = workspace.addSource({ kind: 'identifier', raw: candidate.url }, scope);
    workspace.updateData(data => { Object.assign(data.documents[id], { identifiers: candidate.identifiers, pdfUrl: 'https://example.org/expired' }); });
    vi.mocked(fetch).mockImplementation(url => String(url).endsWith('/resolve') ? Promise.resolve(json({ ...candidate, identifiers: { ...candidate.identifiers, arxiv: '1706.03762v7' }, pdfUrl: 'https://example.org/fresh' })) : Promise.resolve(new Response('%PDF-1.4')));
    vi.mocked(attachPdf).mockImplementation(async documentId => { workspace.updateData(data => { Object.assign(data.documents[documentId], { filename: 'v7.pdf', hash: 'hash', assetId: 'v7', pageCount: 1 }); data.documents[documentId].acquisition = undefined; }); return {}; });
    await acquireFullText(id);
    expect(fetch).toHaveBeenCalledWith('/api/sources/pdf', expect.objectContaining({ body: JSON.stringify({ url: 'https://example.org/fresh' }) }));
    expect(workspace.getState().data.documents[id]).toMatchObject({ identifiers: { arxiv: '1706.03762', url: 'https://arxiv.org/abs/1706.03762v7' }, pdfUrl: 'https://example.org/fresh', assetId: 'v7' });
  });

  it('同一DOI的不同发现地址可确认合并，保留各自原摘要及备注', () => {
    const { documentId: id } = workspace.addSource({ kind: 'identifier', raw: 'https://publisher.example/paper' }, scope);
    workspace.updateData(data => {
      data.documents[id].identifiers!.doi = '10.1000/same';
      data.documents[id].abstract = { text: '出版社摘要', url: 'https://publisher.example/paper', retrievedAt: '2026-10-17T00:00:00Z' };
      data.documents['paper-a'].identifiers = { doi: '10.1000/same', url: 'https://doi.org/10.1000/same' };
      data.documents['paper-a'].abstract = { text: '另一来源摘要', url: 'https://doi.org/10.1000/same', retrievedAt: '2026-10-17T00:00:00Z' };
    });
    workspace.mergeDocuments(id, 'paper-a');
    expect(workspace.getState().data.documents['paper-a'].abstractAlternatives).toEqual([expect.objectContaining({ text: '出版社摘要' })]);
    expect(migrateWorkspace(workspace.getState().data).documents['paper-a'].abstract?.text).toBe('另一来源摘要');
  });
});
