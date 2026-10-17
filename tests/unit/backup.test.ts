import { afterEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { ensurePaneLayout, paneGroups } from '../../src/services/panes';
import { contentHash } from '../../src/data/storage';
import { hasFullText } from '../../src/domain/knowledge';
import type { CardProvenance, ContextSnapshot, RegionSource } from '../../src/domain/types';
import { createWorkspaceBackup, MAX_BACKUP_BYTES, MAX_BACKUP_ENTRY_BYTES, readWorkspaceBackup, type BackupAsset } from '../../src/services/backup';

async function fixture() {
  const data = createSeed();
  const assets: BackupAsset[] = [];
  for (const doc of Object.values(data.documents)) {
    if (!hasFullText(doc)) continue;
    const blob = new Blob([`%PDF-1.7\n${doc.id}`], { type: 'application/pdf' });
    doc.hash = await contentHash(await blob.arrayBuffer());
    assets.push({ id: doc.assetId, blob });
  }
  return { data, assets };
}

async function editArchive(blob: Blob, edit: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  edit(files);
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}

async function editWorkspace(blob: Blob, edit: (data: ReturnType<typeof createSeed>) => void) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const data = JSON.parse(strFromU8(files['workspace.json']));
  edit(data);
  files['workspace.json'] = strToU8(JSON.stringify(data));
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  manifest.workspace.size = files['workspace.json'].length;
  manifest.workspace.hash = await contentHash(files['workspace.json'].buffer as ArrayBuffer);
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>]);
}

afterEach(() => vi.unstubAllGlobals());

describe('完整工作区备份', () => {
  it('多窗布局与同篇独立视图、放大状态完整往返，不按文献去重', async () => {
    const { data, assets } = await fixture();
    const session = data.sessions['research-a'];
    const layout = ensurePaneLayout(session, 'research-a');
    const first = paneGroups(layout.root)[0];
    const view = { id: 'backup-source-view', ref: { kind: 'document' as const, id: 'paper-a' }, reading: { pageIndex: 1, scale: 1.25, offset: .37 } };
    first.tabs.push(view); first.activeTabId = view.id;
    layout.root = { kind: 'split', id: 'backup-split', axis: 'column', ratio: .63, first,
      second: { kind: 'group', id: 'backup-second', tabs: [{ ...structuredClone(view), id: 'backup-copy-view', reading: { pageIndex: 2, scale: .75, offset: .66 } }], activeTabId: 'backup-copy-view' } };
    layout.focusedPaneId = 'backup-second'; layout.zoomedPaneId = first.id;
    const normalized = migrateWorkspace(data);
    const restored = await readWorkspaceBackup(await createWorkspaceBackup(data, assets));
    expect(restored.data).toEqual(normalized);
    expect(paneGroups(restored.data.sessions['research-a'].layout!.root).flatMap(group => group.tabs).filter(tab => tab.ref.id === 'paper-a')).toHaveLength(2);
  });
  it('无全文资料可对照和备份，迁移移除无效的界面阅读位置而保留资料', async () => {
    const { data, assets } = await fixture();
    data.sessions['research-a'].mainSplit = { layout: 'vertical', ref: { kind: 'document', id: 'paper-stub' } };
    data.sessions['research-a'].readers['main-secondary:paper-stub'] = { pageIndex: 0, scale: 1 };
    const normalized = migrateWorkspace(data);
    expect(normalized.sessions['research-a'].readers['main-secondary:paper-stub']).toBeUndefined();
    const restored = await readWorkspaceBackup(await createWorkspaceBackup(normalized, assets));
    expect(restored.data.sessions['research-a'].layout).toEqual(normalized.sessions['research-a'].layout);
    expect(paneGroups(restored.data.sessions['research-a'].layout!.root)[1].tabs[0].ref).toEqual({ kind: 'document', id: 'paper-stub' });
    expect(restored.data.documents['paper-stub']).toEqual(normalized.documents['paper-stub']);
  });
  it('无损往返全部资料、阅读位置、未发送内容和 PDF 字节，不改写输入', async () => {
    const { data, assets } = await fixture();
    data.cards['card-a'].body = '迁移时保留的编辑内容';
    data.documents['paper-a'].abstract = { text: '带有来源的作者摘要', url: 'https://example.org/paper', retrievedAt: '2026-10-17T00:00:00Z' };
    data.researches['research-a'].sourceRecords = { 'paper-a': { note: '仅研究A的收录备注', discoveries: [{ url: 'https://example.org/paper', kind: 'ai', requestId: 'original-turn', recommendation: 'AI 推荐段落快照', createdAt: '2026-10-17T00:00:00Z' }] } };
    data.sessions['research-a'].sourcePreview = { candidate: { url: 'https://example.org/another', title: '尚未收录的预览', kind: 'web' } };
    data.conversations['conversation-research-a'].input = '尚未发送的问题';
    data.sessions['research-a'].readers['main:paper-a'] = { pageIndex: 2, scale: 1.5, offset: 0.6 };
    data.sessions['research-a'].readers['main-secondary:paper-a'] = { pageIndex: 0, scale: 0.8, offset: 0.3 };
    data.sessions['research-a'].mainSplit = { layout: 'horizontal', ref: { kind: 'card', id: 'card-a' } };
    data.sessions['research-a'].viewports['board-a'] = { x: 30, y: -40, scale: 0.75 };
    const original = structuredClone(data);
    const backup = await createWorkspaceBackup(data, assets);
    const restored = await readWorkspaceBackup(backup);
    expect(data).toEqual(original);
    expect(restored.data).toEqual(migrateWorkspace(data));
    expect(restored.summary).toMatchObject({ researches: 2, documents: 4, cards: 4, assets: 3 });
    for (const asset of assets) {
      const actual = restored.assets.find(item => item.id === asset.id)!;
      expect(actual.blob.type).toBe('application/pdf');
      expect(await actual.blob.arrayBuffer()).toEqual(await asset.blob.arrayBuffer());
    }
    const zip = unzipSync(new Uint8Array(await backup.arrayBuffer()));
    expect(Object.keys(zip)).toHaveLength(5);
    expect(Object.keys(zip)).toContain('manifest.json');
  });

  it('无全文条目无需资产，新摘录、文稿卡片记录和面板子视图完整往返', async () => {
    const { data, assets } = await fixture();
    data.documents['paper-c'].finishPromptShown = true;
    data.drafts['draft-a'].cardRefs = [{ cardId: 'card-a', insertedAt: '2026-10-17T00:00:00Z', evidenceIds: ['evidence-a'] }];
    data.evidence['evidence-a'] = { ...data.evidence['evidence-a'], researchId: 'research-a', dismissed: true, note: '后续核对', createdAt: '2026-10-17T00:00:00Z' };
    const session = data.sessions['research-a'];
    session.researchView = 'excerpts';
    session.active = { kind: 'researchView', id: 'excerpts' };
    session.recentItems = [{ kind: 'document', id: 'paper-stub' }];
    session.panel = { ...session.panel, mode: 'cards', findEvidenceFor: 'card-unverified', citation: { draftId: 'draft-a', evidenceId: 'evidence-a' } };
    data.sessions.library.libraryFilter = 'research';
    data.sessions.library.libraryResearchId = 'research-a';
    const restored = await readWorkspaceBackup(await createWorkspaceBackup(data, assets));
    expect(restored.data).toEqual(migrateWorkspace(data));
    expect(restored.data.documents['paper-stub'].assetId).toBeUndefined();
    expect(restored.assets).toHaveLength(3);
  });

  it('schema 2 旧备份先迁移页面、面板和摘录，不接受伪装成旧版的无全文条目', async () => {
    const { data, assets } = await fixture();
    const backup = await createWorkspaceBackup(data, assets);
    const legacy = await editWorkspace(backup, value => {
      Object.assign(value, { schemaVersion: 2 });
      delete value.documents['paper-stub'];
      value.researches['research-a'].documentIds = value.researches['research-a'].documentIds.filter(id => id !== 'paper-stub');
      value.documents['paper-c'].readingStatus = 'read';
      for (const draft of Object.values(value.drafts)) delete draft.cardRefs;
      for (const [key, session] of Object.entries(value.sessions)) {
        session.active = key === 'library' ? { kind: 'collection', id: 'documents' } : { kind: 'research', id: key };
        Object.assign(session.panel, { mode: key === 'library' ? 'info' : 'references' });
      }
    });
    const restored = await readWorkspaceBackup(legacy);
    expect(restored.data.schemaVersion).toBe(3);
    expect(Object.keys(restored.data.documents)).toEqual(['paper-a', 'paper-b', 'paper-c']);
    expect(restored.data.sessions['research-a'].active).toEqual({ kind: 'researchView', id: 'home' });
    expect(restored.data.sessions['research-a'].panel.mode).toBe('cards');
    expect(restored.data.sessions.library.panel.mode).toBe('excerpts');
    expect(restored.data.evidence['evidence-a'].researchId).toBe('research-a');
    expect(restored.assets).toHaveLength(3);
    const invalid = await editWorkspace(backup, value => { Object.assign(value, { schemaVersion: 2 }); });
    await expect(readWorkspaceBackup(invalid)).rejects.toThrow(/论文来源/);
  });

  it.each(['stub-evidence', 'stub-snapshot', 'card-ref', 'card-ref-time', 'card-ref-evidence', 'card-ref-evidence-format', 'find-evidence', 'cross-research-find', 'citation', 'cross-research-citation', 'recent', 'research-view', 'library-filter', 'library-research', 'finish-prompt', 'excerpt-research', 'excerpt-dismissed', 'excerpt-note'])('拒绝新字段及子视图的悬空引用：%s', async problem => {
    const { data, assets } = await fixture();
    const backup = await createWorkspaceBackup(data, assets);
    const broken = await editWorkspace(backup, value => {
      const session = value.sessions['research-a'];
      if (problem === 'stub-evidence') value.evidence['evidence-a'].documentId = 'paper-stub';
      if (problem === 'stub-snapshot') value.cards['card-a'].provenance = { researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话', requestId: 'historical', prompt: '', answer: '', selection: '', createdAt: '', generationRequestIds: [], context: [{ evidenceId: 'historical', documentId: 'paper-stub', documentHash: '', title: '无全文', pageIndex: 0, quote: '伪造原文' }] };
      if (problem === 'card-ref') value.drafts['draft-a'].cardRefs = [{ cardId: 'missing', insertedAt: '2026-10-17T00:00:00Z' }];
      if (problem === 'card-ref-time') value.drafts['draft-a'].cardRefs = [{ cardId: 'card-a', insertedAt: 'not-a-date' }];
      if (problem === 'card-ref-evidence') value.drafts['draft-a'].cardRefs = [{ cardId: 'card-a', insertedAt: '2026-10-17T00:00:00Z', evidenceIds: ['missing'] }];
      if (problem === 'card-ref-evidence-format') Object.assign(value.drafts['draft-a'].cardRefs![0], { evidenceIds: [42] });
      if (problem === 'find-evidence') session.panel.findEvidenceFor = 'missing';
      if (problem === 'cross-research-find') value.sessions['research-b'].panel.findEvidenceFor = 'card-a';
      if (problem === 'citation') session.panel.citation = { draftId: 'draft-a', evidenceId: 'missing' };
      if (problem === 'cross-research-citation') value.sessions['research-b'].panel.citation = { draftId: 'draft-a', evidenceId: 'evidence-a' };
      if (problem === 'recent') session.recentItems = [{ kind: 'document', id: 'missing' }];
      if (problem === 'research-view') Object.assign(session, { researchView: 'missing' });
      if (problem === 'library-filter') Object.assign(value.sessions.library, { libraryFilter: 'missing' });
      if (problem === 'library-research') value.sessions.library.libraryResearchId = 'missing';
      if (problem === 'finish-prompt') Object.assign(value.documents['paper-a'], { finishPromptShown: 'yes' });
      if (problem === 'excerpt-research') value.evidence['evidence-a'].researchId = 'missing';
      if (problem === 'excerpt-dismissed') Object.assign(value.evidence['evidence-a'], { dismissed: 'yes' });
      if (problem === 'excerpt-note') Object.assign(value.evidence['evidence-a'], { note: {} });
    });
    await expect(readWorkspaceBackup(broken)).rejects.toThrow(/备份|损坏/);
  });

  it('保留仅被历史问答、卡片来源、结论来源和面板快照引用的区域图片', async () => {
    const { data, assets } = await fixture();
    async function snapshot(id: string): Promise<ContextSnapshot> {
      const blob = new Blob([`historical image ${id}`], { type: 'image/png' });
      const region: RegionSource = { assetId: id, hash: await contentHash(await blob.arrayBuffer()), rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, rotation: 90, width: 400, height: 300 };
      assets.push({ id, blob });
      return { evidenceId: 'historical-evidence', documentId: 'paper-a', documentHash: data.documents['paper-a'].hash!, title: '历史来源', pageIndex: 1, quote: '', kind: 'region', region };
    }
    async function source(id: string): Promise<CardProvenance> {
      return { researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话', requestId: 'frozen-request', prompt: '问题', answer: '回答', selection: '回答', context: [await snapshot(id)], createdAt: '2026-10-16T00:00:00Z', generationRequestIds: [] };
    }
    data.requests['request-a'] = { id: 'request-a', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '问题', body: '回答', context: [await snapshot('region-request')], history: [{ requestId: 'older-request', prompt: '旧问题', body: '旧回答', evidenceIds: ['historical-evidence'], context: [await snapshot('region-history')] }], evidenceIds: [], createdAt: '2026-10-16T00:00:00Z', status: 'done' };
    data.conversations['conversation-research-a'].requestIds = ['request-a'];
    data.cards['card-a'].provenance = await source('region-card');
    data.drafts['draft-a'].cardSources = [{ cardId: 'card-a', title: '创建时标题', provenance: await source('region-conclusion') }];
    data.sessions['research-a'].panel.conversationSource = await source('region-panel');
    data.cardDrafts['card-draft-a'] = { id: 'card-draft-a', researchId: 'research-a', conversationId: 'conversation-research-a', title: '未保存卡片草稿', body: '编辑内容', evidenceIds: [], needsReview: true, revision: 2, status: 'editing', source: await source('region-draft') };
    const backup = await createWorkspaceBackup(data, assets);
    const restored = await readWorkspaceBackup(backup);
    expect(restored.assets).toHaveLength(9);
    expect(restored.data).toEqual(migrateWorkspace(data));
    assets.pop();
    await expect(createWorkspaceBackup(data, assets)).rejects.toThrow(/缺少.*历史区域图片/);
  });

  it('导出补齐未打开的内置示例 PDF，填入内容 hash，备份可离线恢复', async () => {
    const data = createSeed();
    const fetch = vi.fn(async (url: string) => new Response(`%PDF-1.7\n${url}`, { headers: { 'Content-Type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetch);
    const backup = await readWorkspaceBackup(await createWorkspaceBackup(data, []));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(backup.assets).toHaveLength(3);
    expect(backup.data.documents['paper-a'].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.documents['paper-a'].hash).toBe('');
    fetch.mockClear();
    await createWorkspaceBackup(backup.data, backup.assets);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('缺失原 PDF、来源 hash 不一致、活动生成和异常示例 URL 均显式失败', async () => {
    const { data, assets } = await fixture();
    delete data.documents['paper-a'].sampleUrl;
    await expect(createWorkspaceBackup(data, assets.slice(1))).rejects.toThrow(/缺少原 PDF/);
    await expect(createWorkspaceBackup(data, [{ id: assets[0].id, blob: new Blob(['%PDF-1.7\nchanged']) }, ...assets.slice(1)])).rejects.toThrow(/hash 不一致/);
    await expect(createWorkspaceBackup(data, [{ id: assets[0].id, blob: new Blob(['<html>not a PDF</html>']) }, ...assets.slice(1)])).rejects.toThrow(/内容不是 PDF/);
    data.requests['generating'] = { id: 'generating', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '问题', body: '', context: [], evidenceIds: [], createdAt: '', status: 'generating' };
    await expect(createWorkspaceBackup(data, assets)).rejects.toThrow(/先停止/);
    delete data.requests['generating'];
    data.documents['paper-a'].sampleUrl = 'https://untrusted.example/paper.pdf';
    await expect(createWorkspaceBackup(data, [])).rejects.toThrow(/路径无效/);
  });

  it('拒绝已损坏、缺少资产、未知版本、缺少清单的文件', async () => {
    const { data, assets } = await fixture();
    const backup = await createWorkspaceBackup(data, assets);
    const corrupt = await editArchive(backup, files => { files[`assets/${assets[0].id}`][1] ^= 1; });
    await expect(readWorkspaceBackup(corrupt)).rejects.toThrow(/SHA-256/);
    const missing = await editArchive(backup, files => { delete files[`assets/${assets[0].id}`]; });
    await expect(readWorkspaceBackup(missing)).rejects.toThrow(/数量不一致/);
    const version = await editArchive(backup, files => { const manifest = JSON.parse(strFromU8(files['manifest.json'])); manifest.version = 2; files['manifest.json'] = strToU8(JSON.stringify(manifest)); });
    await expect(readWorkspaceBackup(version)).rejects.toThrow(/版本/);
    const noManifest = await editArchive(backup, files => { delete files['manifest.json']; });
    await expect(readWorkspaceBackup(noManifest)).rejects.toThrow(/缺少清单/);
  });

  it.each(['missing-document', 'missing-evidence', 'invalid-page', 'board-edge', 'cross-research', 'missing-card', 'history-region-hash'])('即使 ZIP 文件校验正确，仍拒绝损坏的引用：%s', async problem => {
    const { data, assets } = await fixture();
    const backup = await createWorkspaceBackup(data, assets);
    const broken = await editWorkspace(backup, value => {
      if (problem === 'missing-document') delete value.documents['paper-a'];
      if (problem === 'missing-evidence') value.cards['card-a'].evidenceIds = ['missing'];
      if (problem === 'invalid-page') value.evidence['evidence-a'].pageIndex = 99;
      if (problem === 'board-edge') value.edges['edge-a'].toPlacementId = 'missing';
      if (problem === 'cross-research') value.conversations['conversation-research-a'].researchId = 'missing';
      if (problem === 'missing-card') delete value.cards['card-a'];
      if (problem === 'history-region-hash') value.cards['card-a'].provenance = { researchId: 'research-a', conversationId: 'conversation-research-a', conversationTitle: '对话', requestId: 'old', prompt: '', answer: '', selection: '', createdAt: '', generationRequestIds: [], context: [{ evidenceId: 'old-region', documentId: 'paper-a', documentHash: value.documents['paper-a'].hash!, title: '旧来源', pageIndex: 1, quote: '', kind: 'region', region: { assetId: assets[0].id, hash: '0'.repeat(64), rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, rotation: 0, width: 20, height: 20 } }] };
    });
    await expect(readWorkspaceBackup(broken)).rejects.toThrow(/备份/);
    expect(data).toEqual((await fixture()).data);
  });

  it('在解压前拒绝超限文件、伪造的巨大解包大小、重复路径和目录穿越', async () => {
    const arrayBuffer = vi.fn();
    await expect(readWorkspaceBackup({ size: MAX_BACKUP_BYTES + 4 * 1024 * 1024 + 1, arrayBuffer } as unknown as Blob)).rejects.toThrow(/上限/);
    expect(arrayBuffer).not.toHaveBeenCalled();
    const { data, assets } = await fixture();
    const backup = await createWorkspaceBackup(data, assets);
    const bytes = new Uint8Array(await backup.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const central: number[] = [];
    for (let i = 0; i <= bytes.length - 4; i++) if (view.getUint32(i, true) === 0x02014b50) central.push(i);
    const tooLarge = bytes.slice();
    new DataView(tooLarge.buffer).setUint32(central[0] + 24, MAX_BACKUP_ENTRY_BYTES + 1, true);
    await expect(readWorkspaceBackup(new Blob([tooLarge]))).rejects.toThrow(/上限/);
    const duplicate = bytes.slice();
    duplicate.set(strToU8(`assets/${assets[0].id}`), central[1] + 46);
    duplicate.set(strToU8(`assets/${assets[0].id}`), view.getUint32(central[1] + 42, true) + 30);
    await expect(readWorkspaceBackup(new Blob([duplicate]))).rejects.toThrow(/重复/);
    const traversal = await editArchive(backup, files => { files['../outside'] = strToU8('unsafe'); });
    await expect(readWorkspaceBackup(traversal)).rejects.toThrow(/路径无效/);
  });

  it('拒绝截断、目录越界、ZIP64 和加密标记，在调用解包器前检查 ZIP32 范围', async () => {
    const { data, assets } = await fixture();
    const bytes = new Uint8Array(await (await createWorkspaceBackup(data, assets)).arrayBuffer());
    await expect(readWorkspaceBackup(new Blob([bytes.slice(0, 12)]))).rejects.toThrow(/ZIP 目录损坏/);
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    const first = view.getUint32(end + 16, true);
    const badDirectory = bytes.slice();
    new DataView(badDirectory.buffer).setUint32(end + 16, bytes.length + 1, true);
    await expect(readWorkspaceBackup(new Blob([badDirectory]))).rejects.toThrow(/目录范围/);
    const zip64 = bytes.slice();
    new DataView(zip64.buffer).setUint32(first + 24, 0xffffffff, true);
    await expect(readWorkspaceBackup(new Blob([zip64]))).rejects.toThrow(/ZIP64/);
    const encrypted = bytes.slice();
    new DataView(encrypted.buffer).setUint16(first + 8, view.getUint16(first + 8, true) | 1, true);
    await expect(readWorkspaceBackup(new Blob([encrypted]))).rejects.toThrow(/加密/);
    const badOffset = bytes.slice();
    new DataView(badOffset.buffer).setUint32(first + 42, bytes.length + 100, true);
    await expect(readWorkspaceBackup(new Blob([badOffset]))).rejects.toThrow(/文件头越界/);
  });

  it('仅接收应用生成的 stored ZIP，拒绝重新压缩及谎报解包大小的 DEFLATE 文件', async () => {
    const { data, assets } = await fixture();
    const original = await createWorkspaceBackup(data, assets);
    const files = unzipSync(new Uint8Array(await original.arrayBuffer()));
    const deflated = zipSync(files, { level: 9 });
    await expect(readWorkspaceBackup(new Blob([deflated as Uint8Array<ArrayBuffer>]))).rejects.toThrow(/原始 ZIP/);
    const forged = deflated.slice();
    const view = new DataView(forged.buffer);
    for (let i = 0; i < forged.length - 46; i++) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 1, true);
        break;
      }
    }
    await expect(readWorkspaceBackup(new Blob([forged as Uint8Array<ArrayBuffer>]))).rejects.toThrow(/原始 ZIP/);
  });
});
