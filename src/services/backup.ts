import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from 'fflate';
import { migrateWorkspace } from '../data/migrations';
import { contentHash } from '../data/storage';
import { hasFullText } from '../domain/knowledge';
import type { CardProvenance, ContextSnapshot, RegionSource, Session, WorkspaceData } from '../domain/types';

export type BackupAsset = { id: string; blob: Blob };
export type WorkspaceBackup = {
  data: WorkspaceData;
  assets: BackupAsset[];
  createdAt: string;
  summary: { researches: number; documents: number; cards: number; assets: number; bytes: number };
};
type FileEntry = { path: string; size: number; hash: string };
type AssetEntry = FileEntry & { id: string; type: string };
type Manifest = { format: 'papertrail-workspace'; version: 1; createdAt: string; workspace: FileEntry; assets: AssetEntry[] };

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
export const MAX_BACKUP_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 4098;
const assetIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const has = (map: object, id: string) => typeof id === 'string' && Object.hasOwn(map, id);
function requireValid(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`备份${message}，未替换当前资料。`);
}
function ids(value: unknown): asserts value is string[] {
  requireValid(Array.isArray(value) && value.every(id => typeof id === 'string'), '引用列表损坏');
}
function sizeLimit(size: number, limit: number, label: string) {
  requireValid(Number.isSafeInteger(size) && size >= 0 && size <= limit, `${label}超过 ${limit / 1024 / 1024} MB 上限或大小无效`);
}
function activeGeneration(data: WorkspaceData) {
  return Object.values(data.requests).some(request => request.status === 'generating') || Object.values(data.cardDrafts).some(draft => draft.status === 'generating');
}
export { activeGeneration as hasActiveGeneration };

async function checkPdfAsset(blob: Blob, filename: string) {
  const header = new TextDecoder('ascii').decode(await blob.slice(0, 1024).arrayBuffer());
  requireValid(header.includes('%PDF-'), `原文件内容不是 PDF：${filename}`);
}

function checkZip32(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--;
  requireValid(end >= 0 && end >= bytes.length - 65557, 'ZIP 目录损坏');
  requireValid(end + 22 + view.getUint16(end + 20, true) === bytes.length, 'ZIP 尾部损坏');
  requireValid(view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0 && view.getUint16(end + 8, true) === view.getUint16(end + 10, true), '不支持分卷 ZIP');
  requireValid(end < 20 || view.getUint32(end - 20, true) !== 0x07064b50, '不支持 ZIP64');
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), length = view.getUint32(end + 12, true);
  requireValid(count <= MAX_ENTRIES && start + length === end, 'ZIP 目录范围或数量无效');
  let cursor = start;
  for (let index = 0; index < count; index++) {
    requireValid(cursor + 46 <= end && view.getUint32(cursor, true) === 0x02014b50, 'ZIP 目录条目损坏');
    const size = view.getUint32(cursor + 20, true), originalSize = view.getUint32(cursor + 24, true), offset = view.getUint32(cursor + 42, true);
    requireValid(size !== 0xffffffff && originalSize !== 0xffffffff && offset !== 0xffffffff, '不支持 ZIP64');
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
    requireValid(cursor + 46 + nameLength + extraLength + commentLength <= end, 'ZIP 目录条目越界');
    requireValid(view.getUint16(cursor + 34, true) === 0 && (view.getUint16(cursor + 8, true) & 1) === 0, '不支持分卷或加密 ZIP');
    requireValid(offset + 30 <= start && view.getUint32(offset, true) === 0x04034b50, 'ZIP 文件头越界');
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true);
    requireValid(offset + 30 + localNameLength + localExtraLength + size <= start && localNameLength === nameLength && view.getUint16(offset + 6, true) === view.getUint16(cursor + 8, true) && view.getUint16(offset + 8, true) === view.getUint16(cursor + 10, true), 'ZIP 文件内容范围或文件头不一致');
    for (let n = 0; n < nameLength; n++) requireValid(bytes[offset + 30 + n] === bytes[cursor + 46 + n], 'ZIP 文件名不一致');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  requireValid(cursor === end, 'ZIP 目录长度不一致');
}

/** Validates references, including frozen conversation and region-image snapshots. */
function validateReferences(data: WorkspaceData): Map<string, Set<string>> {
  const hashes = new Map<string, Set<string>>();
  const asset = (id: string, hash: string) => {
    requireValid(assetIdPattern.test(id) && hashPattern.test(hash), '来源资产标识或 SHA-256 损坏');
    const expected = hashes.get(id) ?? new Set<string>();
    expected.add(hash);
    hashes.set(id, expected);
  };
  const views = ['home', 'sources', 'excerpts', 'cards', 'boards', 'drafts'];
  const ref = (value: Session['active']) => {
    requireValid(object(value) && typeof value.kind === 'string', '资源入口损坏');
    const collections = { research: data.researches, document: data.documents, card: data.cards, board: data.boards, draft: data.drafts };
    if (value.kind === 'researchView') requireValid(views.includes(value.id), '研究页面入口损坏');
    else if (value.kind === 'collection') requireValid(['documents', 'cards'].includes(value.id), '集合入口损坏');
    else requireValid(has(collections, value.kind) && has(collections[value.kind], value.id), '引用的资源缺失');
  };
  const page = (documentId: string, pageIndex: number) => {
    requireValid(has(data.documents, documentId), '引用的原论文缺失');
    const document = data.documents[documentId];
    requireValid(hasFullText(document), '引用的原论文没有全文');
    requireValid(Number.isInteger(pageIndex) && pageIndex >= 0 && pageIndex < document.pageCount, '引用页码无效');
  };
  const region = (value?: RegionSource) => {
    requireValid(object(value) && object(value.rect), '区域图片来源损坏');
    const { x, y, width, height } = value.rect;
    requireValid([x, y, width, height, value.width, value.height, value.rotation].every(Number.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.00001 && y + height <= 1.00001 && value.width > 0 && value.height > 0 && value.rotation % 90 === 0, '区域坐标损坏');
    asset(value.assetId, value.hash);
  };
  const evidenceIds = (value: unknown) => {
    ids(value);
    requireValid(value.every(id => has(data.evidence, id)), '引用的证据缺失');
  };
  const context = (items: ContextSnapshot[]) => {
    requireValid(Array.isArray(items), '对话来源快照损坏');
    for (const item of items) {
      requireValid(object(item) && typeof item.evidenceId === 'string' && typeof item.quote === 'string' && typeof item.title === 'string', '对话来源快照损坏');
      page(item.documentId, item.pageIndex);
      requireValid(item.documentHash === data.documents[item.documentId].hash, '历史来源与原 PDF 的 hash 不一致');
      if (item.kind === 'region') region(item.region);
      else requireValid(item.quote.trim(), '对话原文摘录为空');
    }
  };
  const source = (value: CardProvenance) => {
    requireValid(object(value) && typeof value.prompt === 'string' && typeof value.answer === 'string' && typeof value.selection === 'string', '卡片对话来源损坏');
    requireValid(value.origin === undefined || ['conversation', 'excerpts'].includes(value.origin), '卡片来源类型损坏');
    context(value.context);
    ids(value.generationRequestIds);
    if (value.answerEvidenceIds) {
      ids(value.answerEvidenceIds);
      requireValid(value.answerEvidenceIds.every(id => value.context.some(item => item.evidenceId === id)), '对话引用不属于来源快照');
    }
  };
  for (const [key, collection] of Object.entries(data)) {
    if (!['researches', 'documents', 'evidence', 'cards', 'boards', 'placements', 'edges', 'drafts', 'conversations', 'requests', 'cardDrafts'].includes(key)) continue;
    requireValid(object(collection), '记录集合损坏');
    for (const [id, item] of Object.entries(collection)) requireValid(object(item) && item.id === id, '记录标识损坏');
  }
  requireValid(has(data.sessions, 'library'), '全局资料会话缺失');
  requireValid(data.scope.kind === 'library' || data.scope.kind === 'research' && has(data.researches, data.scope.researchId), '当前研究缺失');
  for (const doc of Object.values(data.documents)) {
    if (hasFullText(doc)) asset(doc.assetId, doc.hash);
    requireValid(doc.finishPromptShown === undefined || typeof doc.finishPromptShown === 'boolean', '阅读提示状态损坏');
  }
  for (const item of Object.values(data.evidence)) {
    page(item.documentId, item.pageIndex);
    if (item.kind === 'region') region(item.region);
    else requireValid(item.quote.trim(), '原文摘录为空');
  }
  for (const research of Object.values(data.researches)) {
    requireValid(research.documentIds.every(id => has(data.documents, id)) && research.cardIds.every(id => has(data.cards, id)), '研究关联的资料缺失');
    requireValid(research.cardIds.every(id => data.cards[id].evidenceIds.every(e => research.documentIds.includes(data.evidence[e]?.documentId))), '研究缺少卡片来源论文关联');
  }
  for (const card of Object.values(data.cards)) {
    evidenceIds(card.evidenceIds);
    if (card.provenance) source(card.provenance);
  }
  for (const board of Object.values(data.boards)) requireValid(has(data.researches, board.researchId), '白板所属研究缺失');
  for (const placement of Object.values(data.placements)) {
    requireValid(has(data.boards, placement.boardId) && ['card', 'document'].includes(placement.resourceRef?.kind), '白板摆放来源缺失');
    ref(placement.resourceRef);
  }
  for (const edge of Object.values(data.edges)) {
    requireValid(has(data.boards, edge.boardId) && has(data.placements, edge.fromPlacementId) && has(data.placements, edge.toPlacementId) && data.placements[edge.fromPlacementId].boardId === edge.boardId && data.placements[edge.toPlacementId].boardId === edge.boardId, '白板连线来源缺失');
  }
  for (const draft of Object.values(data.drafts)) {
    requireValid(has(data.researches, draft.researchId), '结论所属研究缺失');
    evidenceIds(draft.evidenceIds);
    for (const item of draft.cardRefs ?? []) {
      requireValid(has(data.cards, item.cardId) && Number.isFinite(Date.parse(item.insertedAt)), '文稿插入的卡片缺失或时间损坏');
      if (item.evidenceIds !== undefined) evidenceIds(item.evidenceIds);
    }
    if (draft.cardSources) {
      requireValid(Array.isArray(draft.cardSources), '结论来源快照损坏');
      for (const item of draft.cardSources) source(item.provenance);
    }
  }
  for (const conversation of Object.values(data.conversations)) {
    requireValid(has(data.researches, conversation.researchId), '对话所属研究缺失');
    evidenceIds(conversation.contextIds);
    ids(conversation.requestIds);
    requireValid(conversation.requestIds.every(id => has(data.requests, id) && data.requests[id].conversationId === conversation.id && data.requests[id].researchId === conversation.researchId), '对话问答记录缺失或跨研究');
  }
  for (const request of Object.values(data.requests)) {
    requireValid(has(data.researches, request.researchId) && has(data.conversations, request.conversationId) && data.conversations[request.conversationId].researchId === request.researchId, '问答所属会话缺失或跨研究');
    context(request.context);
    ids(request.evidenceIds);
    requireValid(request.evidenceIds.every(id => request.context.some(item => item.evidenceId === id)), '问答引用不属于发送快照');
    requireValid(Array.isArray(request.history), '问答历史损坏');
    for (const turn of request.history) {
      context(turn.context);
      ids(turn.evidenceIds);
      requireValid(turn.evidenceIds.every(id => turn.context.some(item => item.evidenceId === id)), '历史引用不属于来源快照');
    }
  }
  for (const draft of Object.values(data.cardDrafts)) {
    requireValid(has(data.researches, draft.researchId) && has(data.conversations, draft.conversationId) && data.conversations[draft.conversationId].researchId === draft.researchId && typeof draft.title === 'string' && typeof draft.body === 'string', '卡片草稿损坏');
    evidenceIds(draft.evidenceIds);
    source(draft.source);
    if (draft.cardId) requireValid(has(data.cards, draft.cardId), '草稿已保存的卡片缺失');
  }
  for (const [key, session] of Object.entries(data.sessions)) {
    requireValid(key === 'library' || has(data.researches, key), '工作区所属研究缺失');
    ref(session.active);
    requireValid(session.researchView === undefined || views.includes(session.researchView), '研究页面损坏');
    requireValid(session.libraryFilter === undefined || ['all', 'unassigned', 'research'].includes(session.libraryFilter), '资料库筛选损坏');
    requireValid(session.libraryResearchId === undefined || has(data.researches, session.libraryResearchId), '资料库关联研究缺失');
    requireValid(session.recentItems === undefined || Array.isArray(session.recentItems), '最近资源列表损坏');
    for (const item of [...session.openItems, ...session.history, ...session.panel.history, ...(session.recentItems ?? [])]) ref(item);
    if (session.panel.ref) ref(session.panel.ref);
    if (session.panel.sourceReturnRef) ref(session.panel.sourceReturnRef);
    if (session.panel.conversationSource) source(session.panel.conversationSource);
    if (session.panel.findEvidenceFor !== undefined) requireValid(key !== 'library' && data.researches[key].cardIds.includes(session.panel.findEvidenceFor), '找依据卡片缺失或跨研究');
    if (session.panel.citation !== undefined) {
      const citation = session.panel.citation;
      requireValid(object(citation) && has(data.drafts, citation.draftId) && data.drafts[citation.draftId].researchId === key && data.drafts[citation.draftId].evidenceIds.includes(citation.evidenceId), '出处链缺失或跨研究');
    }
    for (const [reader, position] of Object.entries(session.readers)) page(reader.replace(/^(main|inspector):/, ''), position.pageIndex);
    if (session.activeConversationId) requireValid(has(data.conversations, session.activeConversationId) && data.conversations[session.activeConversationId].researchId === key, '活动会话跨研究');
  }
  return hashes;
}

export async function createWorkspaceBackup(original: WorkspaceData, originalAssets: BackupAsset[]): Promise<Blob> {
  requireValid(!activeGeneration(original), '前请先停止正在进行的 AI 生成');
  const data = migrateWorkspace(original);
  const assets = new Map<string, Blob>();
  for (const item of originalAssets) {
    requireValid(assetIdPattern.test(item.id) && !assets.has(item.id), '资产标识无效或重复');
    assets.set(item.id, item.blob);
  }
  for (const doc of Object.values(data.documents)) {
    if (!hasFullText(doc)) continue;
    if (!assets.has(doc.assetId) && doc.sampleUrl) {
      requireValid(/^\/samples\/[a-zA-Z0-9._-]+\.pdf$/i.test(doc.sampleUrl), '示例 PDF 路径无效');
      const response = await fetch(doc.sampleUrl);
      requireValid(response.ok, '示例 PDF 获取失败');
      assets.set(doc.assetId, await response.blob());
    }
    const blob = assets.get(doc.assetId);
    requireValid(blob, `缺少原 PDF：${doc.filename}`);
    sizeLimit(blob.size, MAX_BACKUP_ENTRY_BYTES, '单个资产');
    await checkPdfAsset(blob, doc.filename);
    if (!doc.hash) doc.hash = await contentHash(await blob.arrayBuffer());
  }
  const expectedHashes = validateReferences(data);
  const files: Record<string, Uint8Array> = {};
  const entries: AssetEntry[] = [];
  let total = 0;
  requireValid(assets.size <= MAX_ENTRIES - 2, '资产数量超过 4096 项上限');
  for (const [id, blob] of assets) {
    sizeLimit(blob.size, MAX_BACKUP_ENTRY_BYTES, '单个资产');
    total += blob.size;
    sizeLimit(total, MAX_BACKUP_BYTES, '总解包大小');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await contentHash(bytes.buffer as ArrayBuffer);
    requireValid(!expectedHashes.has(id) || [...expectedHashes.get(id)!].every(value => value === hash), '原文件或历史区域图片 hash 不一致');
    const path = `assets/${id}`;
    files[path] = bytes;
    entries.push({ id, path, size: bytes.length, hash, type: blob.type });
  }
  requireValid([...expectedHashes.keys()].every(id => assets.has(id)), '缺少原文件或历史区域图片');
  const workspaceBytes = strToU8(JSON.stringify(data));
  sizeLimit(workspaceBytes.length, MAX_JSON_BYTES, '工作区 JSON');
  files['workspace.json'] = workspaceBytes;
  const manifest: Manifest = { format: 'papertrail-workspace', version: 1, createdAt: new Date().toISOString(), workspace: { path: 'workspace.json', size: workspaceBytes.length, hash: await contentHash(workspaceBytes.buffer as ArrayBuffer) }, assets: entries };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  sizeLimit(total + workspaceBytes.length + files['manifest.json'].length, MAX_BACKUP_BYTES, '总解包大小');
  // PDF and images are already compressed; stored ZIP keeps export fast and predictable.
  return new Blob([zipSync(files, { level: 0 }) as Uint8Array<ArrayBuffer>], { type: 'application/zip' });
}

export async function readWorkspaceBackup(file: Blob): Promise<WorkspaceBackup> {
  sizeLimit(file.size, MAX_BACKUP_BYTES + 4 * 1024 * 1024, 'ZIP 文件');
  requireValid(file.size > 0, '文件为空');
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkZip32(bytes);
  const entries = new Map<string, UnzipFileInfo>();
  let total = 0;
  // Inspect every central-directory entry before allocating any decompressed file.
  unzipSync(bytes, { filter(entry) {
    requireValid(entry.name === 'manifest.json' || entry.name === 'workspace.json' || /^assets\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(entry.name), 'ZIP 文件路径无效');
    requireValid(!entries.has(entry.name), 'ZIP 文件路径重复');
    requireValid(entry.compression === 0, '仅支持 Papertrail 导出的原始 ZIP，请勿重新压缩');
    sizeLimit(entry.originalSize, entry.name.endsWith('.json') ? MAX_JSON_BYTES : MAX_BACKUP_ENTRY_BYTES, '单个文件');
    sizeLimit(entry.size, MAX_BACKUP_ENTRY_BYTES, '压缩文件');
    requireValid(entry.size === entry.originalSize, 'ZIP 文件大小不一致');
    entries.set(entry.name, entry);
    requireValid(entries.size <= MAX_ENTRIES, 'ZIP 文件数量超过 4098 项上限');
    total += entry.originalSize;
    sizeLimit(total, MAX_BACKUP_BYTES, '总解包大小');
    return false;
  } });
  requireValid(entries.has('manifest.json') && entries.has('workspace.json'), '缺少清单或工作区文件');
  const unpacked = unzipSync(bytes);
  const manifest = JSON.parse(strFromU8(unpacked['manifest.json'])) as Manifest;
  requireValid(object(manifest) && manifest.format === 'papertrail-workspace' && manifest.version === 1 && typeof manifest.createdAt === 'string' && Number.isFinite(Date.parse(manifest.createdAt)) && object(manifest.workspace) && manifest.workspace.path === 'workspace.json' && Array.isArray(manifest.assets), '清单版本或格式不受支持');
  requireValid(manifest.assets.length + 2 === entries.size, '清单与文件数量不一致');
  const verify = async (entry: FileEntry) => {
    requireValid(object(entry) && typeof entry.path === 'string' && hashPattern.test(entry.hash), '清单文件格式损坏');
    const content = unpacked[entry.path];
    requireValid(content && entries.has(entry.path) && content.length === entry.size && entries.get(entry.path)!.originalSize === entry.size, '文件缺失或大小不一致');
    requireValid(await contentHash(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer) === entry.hash, '文件 SHA-256 校验失败');
    return content;
  };
  const data = migrateWorkspace(JSON.parse(strFromU8(await verify(manifest.workspace))));
  const expectedHashes = validateReferences(data);
  const assets: BackupAsset[] = [];
  const seenIds = new Set<string>();
  for (const entry of manifest.assets) {
    requireValid(object(entry) && assetIdPattern.test(entry.id) && entry.path === `assets/${entry.id}` && !seenIds.has(entry.id) && typeof entry.type === 'string' && entry.type.length <= 200, '清单资产标识无效或重复');
    seenIds.add(entry.id);
    const content = await verify(entry);
    requireValid(!expectedHashes.has(entry.id) || [...expectedHashes.get(entry.id)!].every(hash => hash === entry.hash), '来源资产 hash 与工作区不一致');
    assets.push({ id: entry.id, blob: new Blob([content as Uint8Array<ArrayBuffer>], { type: entry.type }) });
  }
  requireValid([...expectedHashes.keys()].every(id => seenIds.has(id)), '缺少原文件或历史区域图片');
  const assetMap = new Map(assets.map(asset => [asset.id, asset.blob]));
  for (const doc of Object.values(data.documents)) if (hasFullText(doc)) await checkPdfAsset(assetMap.get(doc.assetId)!, doc.filename);
  return { data, assets, createdAt: manifest.createdAt, summary: { researches: Object.keys(data.researches).length, documents: Object.keys(data.documents).length, cards: Object.keys(data.cards).length, assets: assets.length, bytes: total } };
}

export function downloadWorkspaceBackup(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `papertrail-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
