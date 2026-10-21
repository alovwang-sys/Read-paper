import { useSyncExternalStore } from 'react';
import { contentHash, getAsset } from '../data/storage';
import { hasFullText } from '../domain/knowledge';
import { drawingReferences, parseDrawingScene, validateDrawingRef } from '../domain/drawing';
import { drawingQuestionReferences, drawingSnapshotContent, validateDrawingPng, validateDrawingQuestion } from '../domain/drawing-question';
import type { DrawingQuestion } from '../domain/types';
import { researchMaterialsMarkdown } from '../domain/research';
import type { ContextSnapshot, WorkspaceData } from '../domain/types';
import { workspace } from './workspace';
import { DirectoryError, directoryRequest } from './research-directory';

export type ProjectFile = { path: string; content: string; encoding: 'utf8' | 'base64'; hash: string };
export type ProjectFilesState = { status: 'waiting' | 'saving' | 'saved' | 'error'; updatedAt?: string; error?: string; files?: number };
const states = new Map<string, ProjectFilesState>();
const subscribers = new Set<() => void>();
const waiting: ProjectFilesState = { status: 'waiting' };
function setState(id: string, value: ProjectFilesState) { states.set(id, value); subscribers.forEach(listener => listener()); }
export function useProjectFiles(researchId: string) {
  return useSyncExternalStore(listener => { subscribers.add(listener); return () => subscribers.delete(listener); }, () => states.get(researchId) ?? waiting);
}
const safeId = (id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id) || id.includes('..')) throw new Error('资料标识不能作为安全文件名，目录保存已暂停。');
  return id;
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const pick = <T>(map: Record<string, T>, ids: Set<string>) => Object.fromEntries([...ids].filter(id => Object.hasOwn(map, id)).sort().map(id => [id, map[id]]));
const byResearch = <T extends { researchId: string }>(map: Record<string, T>, id: string) => Object.fromEntries(Object.entries(map).filter(([, item]) => item.researchId === id));
const assetCache = new Map<string, { content: string; hash: string; type: string }>();

export function researchFileData(data: WorkspaceData, researchId: string) {
  const research = data.researches[researchId];
  if (!research) throw new Error('研究不存在。');
  const drafts = byResearch(data.drafts, researchId), boards = byResearch(data.boards, researchId);
  const conversations = byResearch(data.conversations, researchId), requests = byResearch(data.requests, researchId), cardDrafts = byResearch(data.cardDrafts, researchId);
  const placements = Object.fromEntries(Object.entries(data.placements).filter(([, p]) => boards[p.boardId]));
  const edges = Object.fromEntries(Object.entries(data.edges).filter(([, edge]) => boards[edge.boardId]));
  const boardChanges = byResearch(data.boardChanges ?? {}, researchId);
  const boardIds = new Set([...Object.keys(boards), ...Object.values(boardChanges).map(change => change.boardId)]);
  const boardRevisions = pick(data.boardRevisions ?? {}, boardIds);
  const cardIds = new Set(research.cardIds), documentIds = new Set(research.documentIds), evidenceIds = new Set<string>();
  const context = (items: ContextSnapshot[] = []) => items.forEach(item => { documentIds.add(item.documentId); evidenceIds.add(item.evidenceId); });
  const historicalPlacements = Object.values(boardChanges).flatMap(change => [change.before, change.after].flatMap(snapshot => snapshot?.placements ?? []));
  const requestedPlacements = Object.values(requests).flatMap(request => request.boardContext?.snapshot.placements ?? []);
  for (const p of [...Object.values(placements), ...historicalPlacements, ...requestedPlacements]) {
    if (p.resourceRef.kind === 'card') cardIds.add(p.resourceRef.id);
    if (p.resourceRef.kind === 'document') documentIds.add(p.resourceRef.id);
  }
  for (const draft of Object.values(drafts)) {
    draft.evidenceIds.forEach(id => evidenceIds.add(id));
    draft.cardRefs?.forEach(ref => { cardIds.add(ref.cardId); ref.evidenceIds?.forEach(id => evidenceIds.add(id)); });
    draft.cardSources?.forEach(source => context(source.provenance.context));
  }
  const cards = pick(data.cards, cardIds);
  const archivedCards = Object.fromEntries(Object.values(boardChanges).flatMap(change => change.createdCards ?? []).filter(card => !Object.hasOwn(cards, card.id)).map(card => [card.id, card]));
  for (const card of Object.values(archivedCards)) { card.evidenceIds.forEach(id => evidenceIds.add(id)); context(card.provenance?.context); }
  for (const card of Object.values(cards)) { card.evidenceIds.forEach(id => evidenceIds.add(id)); context(card.provenance?.context); }
  for (const c of Object.values(conversations)) { c.contextIds.forEach(id => evidenceIds.add(id)); context(c.sentContext); }
  for (const request of Object.values(requests)) { context(request.context); request.history?.forEach(turn => context(turn.context)); }
  for (const draft of Object.values(cardDrafts)) { draft.evidenceIds.forEach(id => evidenceIds.add(id)); context(draft.source.context); }
  for (const evidence of Object.values(data.evidence)) if (evidence.researchId === researchId || !evidence.researchId && documentIds.has(evidence.documentId)) evidenceIds.add(evidence.id);
  const evidence = pick(data.evidence, evidenceIds);
  Object.values(evidence).forEach(e => documentIds.add(e.documentId));
  return { research, documents: pick(data.documents, documentIds), evidence, cards, archivedCards, boards, placements, edges, boardChanges, boardRevisions, drafts, conversations, requests, cardDrafts };
}

export async function buildResearchFiles(data: WorkspaceData, researchId: string): Promise<{ files: ProjectFile[] }> {
  const entities = researchFileData(data, researchId), files: ProjectFile[] = [];
  const assets = new Map<string, { path: string; hash: string; type: string }>();
  const text = async (path: string, content: string) => files.push({ path, content, encoding: 'utf8', hash: await contentHash(new TextEncoder().encode(content).buffer) });
  const imagePath = (path: string, type: string) => {
    const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[type];
    if (!extension) throw new Error('区域图片格式不受支持，目录保存已暂停。');
    return path.replace(/\.png$/, '.' + extension);
  };
  const asset = async (id: string, expected: string, path: string, sampleUrl?: string, image = false, drawing = false) => {
    const existing = assets.get(id);
    if (existing) {
      if (expected && existing.hash !== expected) throw new Error('同一原始资产的 hash 不一致，目录保存已暂停。');
      return existing.path;
    }
    const cached = !drawing && expected && assetCache.get(`${id}:${expected}`);
    if (cached) {
      if (image) path = imagePath(path, cached.type);
      files.push({ path, content: cached.content, hash: cached.hash, encoding: 'base64' });
      assets.set(id, { path, hash: cached.hash, type: cached.type });
      return path;
    }
    let blob = await getAsset(id);
    if (!blob && sampleUrl) {
      if (!/^\/samples\/[a-zA-Z0-9._-]+\.pdf$/i.test(sampleUrl)) throw new Error('示例 PDF 路径无效。');
      const response = await fetch(sampleUrl); if (!response.ok) throw new Error('无法读取原始 PDF。'); blob = await response.blob();
    }
    if (!blob) throw new Error(`原始资产缺失：${id}，本地资料已保留。`);
    if (image) path = imagePath(path, blob.type);
    if (blob.size > 64 * 1024 * 1024) throw new Error('单个资料超过目录保存的 64 MB 上限。');
    const bytes = new Uint8Array(await blob.arrayBuffer()), hash = await contentHash(bytes.buffer as ArrayBuffer);
    if (expected && hash !== expected) throw new Error('原始资料 hash 不匹配，目录保存已暂停。');
    if (drawing) parseDrawingScene(new TextDecoder().decode(bytes));
    let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    const content = btoa(binary);
    files.push({ path, content, encoding: 'base64', hash });
    assetCache.set(`${id}:${hash}`, { content, hash, type: blob.type });
    assets.set(id, { path, hash, type: blob.type });
    return path;
  };
  for (const drawing of drawingReferences({ ...data, boards: entities.boards, boardChanges: entities.boardChanges, requests: entities.requests })) {
    validateDrawingRef(drawing);
    await asset(drawing.assetId, drawing.hash, `drawings/${safeId(drawing.assetId)}.excalidraw`, undefined, false, true);
  }
  for (const question of drawingQuestionReferences(entities)) {
    validateDrawingQuestion(question);
    const snapshot = question.snapshot, blob = await getAsset(snapshot.image.assetId);
    if (!blob || await contentHash(new TextEncoder().encode(drawingSnapshotContent(snapshot)).buffer) !== snapshot.hash) throw new Error('绘图问题快照或图片缺失，目录保存已暂停。');
    validateDrawingPng(await blob.arrayBuffer(), snapshot.image);
    await asset(snapshot.image.assetId, snapshot.image.hash, `images/${safeId(snapshot.image.assetId)}.png`, undefined, true);
  }
  for (const doc of Object.values(entities.documents)) {
    const path = hasFullText(doc) ? await asset(doc.assetId, doc.hash, `library/${safeId(doc.id)}.pdf`, doc.sampleUrl) : undefined;
    await text(`library/${safeId(doc.id)}.md`, `# ${doc.title}\n\n${doc.authors || '作者未记录'} · ${doc.year || '年份未记录'}\n\n${path ? `[原始 PDF](${doc.id}.pdf) · ${doc.pageCount} 页` : '尚未添加全文。'}\n\n${json(doc.identifiers ?? {})}\n${doc.discovery ? `\n## 发现来源\n\n${doc.discovery.provider} · ${doc.discovery.providerId} · ${doc.discovery.retrievedAt}\n\n[来源](${doc.discovery.url})\n\n${doc.discovery.abstract || '来源未提供摘要。'}\n\n${doc.discovery.pdfUrl ? `[公开 PDF 链接](${doc.discovery.pdfUrl})；文件尚未获取。` : '没有提供公开 PDF 链接。'}\n` : ''}`);
  }
  const regions = [
    ...Object.values(entities.evidence).map(e => e.region),
    ...Object.values(entities.cards).flatMap(c => c.provenance?.context.map(c => c.region) ?? []),
    ...Object.values(entities.archivedCards).flatMap(c => c.provenance?.context.map(c => c.region) ?? []),
    ...Object.values(entities.requests).flatMap(r => [...r.context, ...(r.history?.flatMap(t => t.context) ?? [])].map(c => c.region)),
    ...Object.values(entities.cardDrafts).flatMap(d => d.source.context.map(c => c.region)),
    ...Object.values(entities.conversations).flatMap(c => c.sentContext?.map(c => c.region) ?? []),
    ...Object.values(entities.drafts).flatMap(d => d.cardSources?.flatMap(s => s.provenance.context.map(c => c.region)) ?? []),
  ].filter(region => !!region);
  for (const region of regions) await asset(region.assetId, region.hash, `images/${safeId(region.assetId)}.png`, undefined, true);
  const sources = (ids: string[]) => ids.map((id, i) => {
    const e = entities.evidence[id], doc = e && entities.documents[e.documentId];
    return e && doc ? `### [${i + 1}] ${doc.title} · PDF 第 ${e.pageIndex + 1} 页\n\n[原文](../library/${safeId(doc.id)}.pdf#page=${e.pageIndex + 1})\n\n${e.quote.split('\n').map(line => '> ' + line).join('\n')}\n${e.note ? '\n笔记：' + e.note + '\n' : ''}${e.region ? `\n[原始区域图片](../${assets.get(e.region.assetId)?.path})\n` : ''}` : `来源缺失：${id}`;
  }).join('\n\n');
  for (const e of Object.values(entities.evidence)) await text(`excerpts/${safeId(e.id)}.md`, `# 摘录\n\n${sources([e.id])}\n`);
  for (const card of Object.values(entities.cards)) await text(`cards/${safeId(card.id)}.md`, `# ${card.title}\n\n${card.body}\n\n## 原文依据\n\n${sources(card.evidenceIds) || '尚未关联原文依据。'}\n${card.provenance ? `\n## 形成过程\n\n${card.provenance.conversationTitle}\n\n${card.provenance.selection || card.provenance.answer}\n${researchMaterialsMarkdown(card.provenance.materials)}` : ''}${card.drawingOrigin ? `\n## 绘图文字来路\n\n白板：${card.drawingOrigin.boardId}；元素：${card.drawingOrigin.elementIds.join('、')}\n\n${card.drawingOrigin.text}\n` : ''}`);
  for (const draft of Object.values(entities.drafts)) await text(`drafts/${safeId(draft.id)}.md`, `# ${draft.title}\n\n${draft.body}\n\n## 原文依据\n\n${sources(draft.evidenceIds)}\n`);
  for (const board of Object.values(entities.boards)) await text(`boards/${safeId(board.id)}.json`, json({ board, drawingPath: board.drawing ? `../${assets.get(board.drawing.assetId)!.path}` : undefined, placements: Object.values(entities.placements).filter(p => p.boardId === board.id), edges: Object.values(entities.edges).filter(e => e.boardId === board.id) }));
  const sessionIndex: string[] = ['# 研究对话', '', 'Markdown 是可读归档，原生会话日志仍由对应助手保存。原生 ID 可用于在同一台机器继续会话；复制本目录不会复制登录或厂商会话数据库。', ''];
  const drawingMarkdown = (question?: DrawingQuestion) => question ? `\n\n### 当轮绘图快照\n\n${question.snapshot.boardTitle} · ${question.mode === 'image' ? '图片和文字' : '仅文字和结构，未看图'} · 未追加论文原文\n\n[当时的选区图片](../${assets.get(question.snapshot.image.assetId)!.path})\n\n\`\`\`json\n${json(question.snapshot)}\n\`\`\`` : '';
  for (const c of Object.values(entities.conversations)) {
    const heading = c.title || '研究对话';
    const native = c.nativeSessionId ? `助手：${c.connectionId || '未知'}  \n原生 Session ID：\`${c.nativeSessionId}\`\n\n${c.connectionId === 'codex' && /^[a-zA-Z0-9_-]+$/.test(c.nativeSessionId) ? `在本研究目录运行：\n\n\`\`\`sh\ncodex resume ${c.nativeSessionId}\n\`\`\`\n` : ''}` : '此对话尚无原生 Session ID，或使用模型直连/演示模式。';
    const turns = c.requestIds.map(id => entities.requests[id]).filter(Boolean).map(r => `## 用户\n\n${r.prompt}${r.supplementalInputs?.map(input => '\n\n### 本轮补充\n\n' + input.text).join('') || ''}${drawingMarkdown(r.researchRun?.drawingQuestion)}\n\n## 助手\n\n${r.body}\n\n状态：${r.status}${r.materials?.length ? `\n\n### 当轮附送材料\n\n${researchMaterialsMarkdown(r.materials)}` : ''}`).join('\n\n');
    const searches = c.literatureSearches?.map(batch => `## 文献检索：${batch.query}\n\n原问题：${batch.rootTitle}；状态：${batch.status}；时间：${batch.createdAt}\n\n${batch.candidates.map(candidate => `- [${candidate.title}](${candidate.url}) · ${candidate.providerId}${candidate.documentId ? ` · 已收录 ${candidate.documentId}` : ''}`).join('\n')}`).join('\n\n') || '';
    await text(`sessions/${safeId(c.id)}.md`, `# ${heading}\n\n${native}\n\n${turns}${searches ? '\n\n' + searches : ''}${c.input || c.drawingQuestion ? '\n\n## 未发送输入\n\n' + (c.input ?? '') + drawingMarkdown(c.drawingQuestion) : ''}\n`);
    sessionIndex.push(`- [${heading}](${safeId(c.id)}.md)${c.nativeSessionId ? ` · ${c.connectionId} · \`${c.nativeSessionId}\`` : ''}`);
  }
  await text('sessions/index.md', sessionIndex.join('\n'));
  await text('research.md', `# ${entities.research.title}\n\n${entities.research.question || '研究问题尚待明确。'}\n`);
  await text('research.json', json({ format: 'papertrail-research', version: 1, entities, assets: Object.fromEntries(assets) }));
  await text('README.md', `# ${entities.research.title}\n\n${entities.research.question}\n\n## 研究文件\n\n- [研究说明](research.md)与[结构化数据](research.json)\n- library/：原始 PDF 和文献信息\n- excerpts/：摘录与页码\n- cards/：观点卡片与原文依据\n- drafts/：文稿与引用\n- boards/：白板布局、关系和绘图文件路径\n- drawings/：可由 Excalidraw 直接打开的绘图与内嵌图片（含本研究历史版本）\n- [会话索引](sessions/index.md)：可读聊天、原生会话 ID 和 Codex 续接方式\n\n这些是当前研究的实际本地文件，原始资料按 hash 校验。应用自动更新此文件集，同时保留本地数据库作为恢复副本。请从应用编辑卡片等内容；外部修改会保留并暂停后续覆盖，不会自动回写到应用。共享资料会在其关联的研究目录各保存一份。\n\n## 在 Codex 中使用\n\n在 Codex 中打开此研究根目录，读取 Papertrail/README.md 即可找到材料。原生会话保留本机记录及原生 ID，属于同一 cwd；必要时查看会话索引并执行 codex resume <Session ID>。Markdown 归档不等于厂商原生日志，原生客户端是否列出特定来源的会话取决于其筛选规则。目录不会复制登录凭据，也不会自动向模型发送全部文件。\n`);
  return { files };
}

let installed = false;
let syncing: Promise<void> | undefined;
type SyncTask = { data: WorkspaceData; identity: string; generation: number };
const pending = new Map<string, SyncTask>();
const fingerprints = new Map<string, string>();
const sentHashes = new Map<string, Map<string, string>>();
const identities = new Map<string, string>();
let generation = -1;
let active: { id: string; controller: AbortController } | undefined;
let schedule: ReturnType<typeof setTimeout> | undefined;
function identity(data: WorkspaceData, id: string) {
  const directory = data.researches[id]?.directory;
  return directory && data.agentWorkspaceId ? JSON.stringify([data.agentWorkspaceId, id, directory.id, directory.path]) : undefined;
}
function reconcile() {
  const data = workspace.getState().data, nextGeneration = workspace.getGeneration();
  let changed = false;
  if (generation !== nextGeneration) {
    active?.controller.abort();
    generation = nextGeneration;
    states.clear(); pending.clear(); fingerprints.clear(); sentHashes.clear(); identities.clear(); assetCache.clear();
    changed = true;
  }
  const current = new Map(Object.keys(data.researches).flatMap(id => { const key = identity(data, id); return key ? [[id, key] as const] : []; }));
  for (const [id, key] of identities) if (current.get(id) !== key) {
    if (active?.id === id) active.controller.abort();
    states.delete(id); pending.delete(id); fingerprints.delete(id); sentHashes.delete(key);
    changed = true;
  }
  identities.clear(); current.forEach((key, id) => identities.set(id, key));
  if (changed) subscribers.forEach(listener => listener());
}
function currentTask(id: string, task: SyncTask) {
  return workspace.getGeneration() === task.generation && identity(workspace.getState().data, id) === task.identity;
}
function fingerprint(data: WorkspaceData, id: string) { return JSON.stringify([data.agentWorkspaceId, researchFileData(data, id)]); }
export function installProjectFileSync() {
  if (installed) return;
  installed = true;
  let lastData: WorkspaceData | undefined, lastGeneration = -1;
  workspace.subscribe(() => {
    reconcile();
    const { data, loaded, loadError, saveStatus } = workspace.getState();
    if (!loaded || loadError || saveStatus !== 'saved' || data === lastData && generation === lastGeneration) return;
    lastData = data; lastGeneration = generation;
    for (const research of Object.values(data.researches)) {
      const key = identity(data, research.id);
      if (!key || Object.values(data.requests).some(r => r.researchId === research.id && r.status === 'generating')) continue;
      if (fingerprints.get(research.id) === fingerprint(data, research.id)) continue;
      pending.set(research.id, { data, identity: key, generation });
      if (states.get(research.id)?.status !== 'error') setState(research.id, { ...states.get(research.id), status: 'waiting' });
    }
    clearTimeout(schedule); schedule = setTimeout(() => void runSync(), 1000);
  });
}
async function runSync(): Promise<void> {
  reconcile();
  if (syncing) return syncing;
  syncing = (async () => {
    while (pending.size) {
      const [id, task] = pending.entries().next().value!; pending.delete(id);
      if (states.get(id)?.status === 'error' || !currentTask(id, task)) continue;
      const data = task.data, directory = data.researches[id].directory!;
      const controller = new AbortController(); active = { id, controller };
      setState(id, { ...states.get(id), status: 'saving' });
      try {
        const payload = await buildResearchFiles(data, id);
        if (!currentTask(id, task)) continue;
        const hashes = sentHashes.get(task.identity);
        const files = payload.files.map(file => hashes?.get(file.path) === file.hash ? { path: file.path, hash: file.hash, encoding: file.encoding, reuse: true } : file);
        const project = { workspaceId: data.agentWorkspaceId!, researchId: id };
        let result: { updatedAt: string; files: number };
        try { result = await directoryRequest(project, 'sync', { bindingId: directory.id, files }, controller.signal); }
        catch (error) {
          if (!currentTask(id, task) || !(error instanceof DirectoryError) || error.code !== 'project_files_reuse_unavailable') throw error;
          sentHashes.delete(task.identity);
          result = await directoryRequest(project, 'sync', { bindingId: directory.id, ...payload }, controller.signal);
        }
        if (!currentTask(id, task)) continue;
        sentHashes.set(task.identity, new Map(payload.files.map(file => [file.path, file.hash])));
        fingerprints.set(id, fingerprint(data, id));
        setState(id, { status: 'saved', updatedAt: result.updatedAt, files: result.files });
      } catch (error) {
        if (currentTask(id, task)) setState(id, { status: 'error', error: error instanceof Error ? error.message : '目录保存失败，应用内资料已保留。' });
      } finally { if (active?.controller === controller) active = undefined; }
    }
  })().finally(() => { syncing = undefined; });
  return syncing;
}
export async function syncResearchFiles(researchId: string) {
  const initial = workspace.getState().data, initialGeneration = workspace.getGeneration(), key = identity(initial, researchId);
  if (!key) throw new Error('研究尚未关联目录。');
  await workspace.flushSave();
  reconcile();
  const task = { data: workspace.getState().data, identity: key, generation: initialGeneration };
  if (!currentTask(researchId, task)) throw new Error('工作区或研究目录已改变，请重新保存。');
  setState(researchId, { ...states.get(researchId), status: 'waiting', error: undefined });
  pending.set(researchId, task);
  await runSync();
  if (!currentTask(researchId, task)) throw new Error('工作区或研究目录已改变，请重新保存。');
  const result = states.get(researchId);
  if (result?.status === 'error') throw new Error(result.error);
}
export async function flushProjectFiles() {
  clearTimeout(schedule);
  reconcile();
  await runSync();
  const failure = [...states.values()].find(s => s.status === 'error');
  if (failure) throw new Error(`目录文件尚未保存：${failure.error}。应用内资料已保存，可返回后重试。`);
}
