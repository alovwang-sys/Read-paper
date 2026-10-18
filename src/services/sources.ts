import type { PaperDocument, SourceCandidate, SourceDiscovery, WorkspaceScope } from '../domain/types';
import { hasFullText, normalizeIdentifier } from '../domain/knowledge';
import { attachPdf } from './pdf';
import { scopeKey, workspace } from './workspace';

export function sourceCandidate(raw: string, title?: string): SourceCandidate {
  const identifier = normalizeIdentifier(raw);
  if (!identifier) throw new Error('请提供有效的 DOI、arXiv 编号或网页链接。');
  const version = identifier.kind === 'arxiv' ? raw.replace(/[?#].*$/, '').match(/v\d+(?:\.pdf)?$/i)?.[0].replace(/\.pdf$/i, '').toLowerCase() ?? '' : '';
  const url = identifier.kind === 'doi' ? `https://doi.org/${identifier.value}` : identifier.kind === 'arxiv' ? `https://arxiv.org/abs/${identifier.value}${version}` : identifier.value;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) throw new Error('来源链接不能包含登录凭据。');
  return { url, title: title?.trim() || (identifier.kind === 'url' ? parsed.hostname : `${identifier.value}${version}`), kind: identifier.kind === 'url' ? 'web' : 'paper', identifiers: { [identifier.kind]: identifier.value, url } };
}

/** Only explicit links are candidates; prose titles never become invented references. */
export function extractSourceLinks(text: string): SourceCandidate[] {
  const links: SourceCandidate[] = [];
  const add = (url: string, title?: string) => {
    try {
      const candidate = sourceCandidate(url, title?.replace(/[*`]/g, ''));
      const parsed = new URL(candidate.url);
      if (/^(?:www\.)?(?:google|bing|baidu)\./i.test(parsed.hostname) && /search|s$/.test(parsed.pathname)) return;
      if (!links.some(link => link.url === candidate.url || candidate.identifiers?.doi && link.identifiers?.doi === candidate.identifiers.doi || candidate.identifiers?.arxiv && link.identifiers?.arxiv === candidate.identifiers.arxiv)) links.push(candidate);
    } catch { /* Non-web references stay readable in the answer. */ }
  };
  const withoutCode = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const rest = withoutCode.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s]+?)(?:\s+"[^"\n]*")?\)(?=[\s.,;，。；]|$)/g, (_all, title: string, url: string) => { add(url, title); return ''; });
  for (const match of rest.matchAll(/https?:\/\/[^\s<>"\[\]，。；]+/g)) add(match[0].replace(/[.,;!?)]+$/, ''));
  for (const match of rest.matchAll(/\b(?:doi:\s*)(10\.\d{4,9}\/[^\s<>，。；]+)/gi)) add(match[1].replace(/[.,;]+$/, ''));
  for (const match of rest.matchAll(/\barxiv:\s*((?:\d{4}\.\d{4,5}|[a-z-]+\/[0-9]{7})(?:v\d+)?)/gi)) add(`arxiv:${match[1]}`);
  return links;
}

export function findSource(candidate: SourceCandidate): PaperDocument | undefined {
  const normalized = sourceCandidate(candidate.url);
  const identifiers = { ...normalized.identifiers, ...candidate.identifiers };
  return Object.values(workspace.getState().data.documents).find(doc =>
    Object.entries(identifiers).some(([key, value]) => value && doc.identifiers?.[key as 'doi' | 'arxiv' | 'url'] === value),
  );
}

async function sourceResponse(path: string, url: string) {
  const response = await fetch(`/api/sources/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(typeof error.error === 'string' ? error.error : '暂时无法获取来源，请打开原网页或稍后重试。');
  }
  return response;
}

export async function resolveSource(candidate: SourceCandidate): Promise<SourceCandidate> {
  const fallback = sourceCandidate(candidate.url, candidate.title);
  const result = await (await sourceResponse('resolve', fallback.url)).json() as SourceCandidate;
  if (!result || typeof result.url !== 'string' || typeof result.title !== 'string' || !['paper', 'web'].includes(result.kind)) throw new Error('来源信息格式无效，可以先保存原链接。');
  const normalized = sourceCandidate(result.url);
  const identifiers = { ...fallback.identifiers, ...normalized.identifiers };
  for (const key of ['doi', 'arxiv'] as const) {
    const value = result.identifiers?.[key];
    if (value === undefined) continue;
    const identifier = typeof value === 'string' && normalizeIdentifier(`${key}:${value}`);
    if (!identifier || identifier.kind !== key) throw new Error('来源标识格式无效，可以先保存原链接。');
    identifiers[key] = identifier.value;
  }
  if (result.abstract && (typeof result.abstract.text !== 'string' || typeof result.abstract.retrievedAt !== 'string' || !Number.isFinite(Date.parse(result.abstract.retrievedAt)))) throw new Error('摘要来源信息不完整，可以先保存链接。');
  if (result.abstract) sourceCandidate(result.abstract.url);
  if (result.pdfUrl) sourceCandidate(result.pdfUrl);
  return { ...fallback, ...result, identifiers, title: result.warning && !result.metadataSource ? fallback.title : result.title };
}

const collecting = new Map<string, Promise<string>>();
const acquiring = new Map<string, Promise<void>>();
const collectionKey = (candidate: SourceCandidate, scope: WorkspaceScope) => `${workspace.getGeneration()}:${scopeKey(scope)}:${sourceCandidate(candidate.url).url}`;
export const isCollectingSource = (candidate: SourceCandidate, scope: WorkspaceScope) => collecting.has(collectionKey(candidate, scope));

function remember(documentId: string, scope: WorkspaceScope, discovery?: SourceDiscovery) {
  if (scope.kind !== 'research') return;
  workspace.updateData(data => {
    const research = data.researches[scope.researchId];
    if (!research) throw new Error('研究不存在。');
    research.sourceRecords ??= {};
    const entry = research.sourceRecords[documentId] ??= { note: '', discoveries: [] };
    if (discovery && !entry.discoveries.some(item => item.url === discovery.url && item.requestId === discovery.requestId && item.conversationId === discovery.conversationId)) entry.discoveries.push(discovery);
  });
}

export function collectSource(candidate: SourceCandidate, scope: WorkspaceScope, discovery?: SourceDiscovery): Promise<string> {
  const key = collectionKey(candidate, scope);
  const pending = collecting.get(key);
  if (pending) return pending;
  const operation = Promise.resolve().then(async () => {
    const generation = workspace.getGeneration();
    const existing = findSource(candidate);
    const result = workspace.addSource(existing ? { kind: 'library', documentId: existing.id } : { kind: 'identifier', raw: candidate.url }, scope);
    const documentId = result.documentId;
    if (result.created) workspace.updateData(data => {
      Object.assign(data.documents[documentId], { title: candidate.title, authors: candidate.authors ?? '', year: candidate.year ?? '', identifiers: { ...data.documents[documentId].identifiers, ...candidate.identifiers }, abstract: candidate.abstract, metadataSource: candidate.metadataSource, sourceKind: candidate.kind, pdfUrl: candidate.pdfUrl });
    });
    remember(documentId, scope, discovery ?? { url: candidate.url, kind: 'link', createdAt: new Date().toISOString() });
    await workspace.flushSave();
    if (workspace.getGeneration() !== generation) throw new Error('工作区已重新加载，原收录已保存，请回原研究核对。');
    if (!hasFullText(workspace.getState().data.documents[documentId])) void acquireFullText(documentId).catch(() => {});
    return documentId;
  }).finally(() => { collecting.delete(key); });
  collecting.set(key, operation);
  return operation;
}

export function acquireFullText(documentId: string): Promise<void> {
  const generation = workspace.getGeneration();
  const key = `${generation}:${documentId}`;
  const pending = acquiring.get(key);
  if (pending) return pending;
  const operation = (async () => {
    const original = workspace.getState().data.documents[documentId];
    if (!original || hasFullText(original)) return;
    const url = original.identifiers?.url ?? (original.identifiers?.doi ? `https://doi.org/${original.identifiers.doi}` : original.identifiers?.arxiv ? `https://arxiv.org/abs/${original.identifiers.arxiv}` : undefined);
    if (!url) return;
    const current = () => generation === workspace.getGeneration() ? workspace.getState().data.documents[documentId] : undefined;
    const canApply = () => !!current() && !hasFullText(current());
    try {
      workspace.updateData(data => { data.documents[documentId].acquisition = { status: 'fetching', url }; });
      await workspace.flushSave();
      const resolved = await resolveSource({ ...sourceCandidate(url, original.title), pdfUrl: original.pdfUrl });
      if (!canApply()) return;
      workspace.updateData(data => {
        const doc = data.documents[documentId];
        // Compare each field with the submitted snapshot, preserving edits made while fetching.
        for (const field of ['title', 'authors', 'year'] as const) if (doc[field] === original[field] && resolved[field] && (field !== 'title' || !resolved.warning || resolved.metadataSource)) doc[field] = resolved[field]!;
        const conflicting = Object.entries(resolved.identifiers ?? {}).some(([key, value]) => key !== 'url' && doc.identifiers?.[key as 'doi' | 'arxiv'] && doc.identifiers[key as 'doi' | 'arxiv'] !== value);
        if (conflicting) throw new Error('来源标识与当前条目不一致，资料已保留，请核对后补充全文。');
        doc.identifiers = { ...resolved.identifiers, ...doc.identifiers };
        doc.abstract ??= resolved.abstract;
        doc.metadataSource ??= resolved.metadataSource;
        if (doc.sourceKind === original.sourceKind) doc.sourceKind = resolved.kind;
        if (doc.pdfUrl === original.pdfUrl && resolved.pdfUrl) doc.pdfUrl = resolved.pdfUrl;
      });
      const doc = current()!;
      const duplicate = Object.values(workspace.getState().data.documents).find(other => other.id !== documentId && (['doi', 'arxiv'] as const).some(key => doc.identifiers?.[key] && other.identifiers?.[key] === doc.identifiers[key]));
      if (duplicate) {
        workspace.updateData(data => { data.documents[documentId].acquisition = { status: 'conflict', conflictDocumentId: duplicate.id, url, message: '资料库中已有相同文献标识的条目，请核对并合并；已有内容保持不变。' }; });
        await workspace.flushSave();
        return;
      }
      if (!doc.pdfUrl) {
        workspace.updateData(data => { data.documents[documentId].acquisition = { status: 'unavailable', url, message: resolved.warning || (resolved.kind === 'web' ? '已保存链接，尚未获取可下载的 PDF。' : '暂未取得全文，可打开原网页，或在此添加 PDF。') }; });
        await workspace.flushSave();
        return;
      }
      const response = await sourceResponse('pdf', doc.pdfUrl);
      const blob = await response.blob();
      if (!canApply()) return;
      const result = await attachPdf(documentId, new File([blob], `${doc.title.replace(/[/\\]/g, '-')}.pdf`, { type: 'application/pdf' }), { automatic: true, generation });
      if (!current()) return;
      if (result.conflict) workspace.updateData(data => { data.documents[documentId].acquisition = { status: 'conflict', url, conflictDocumentId: result.conflict!.into, message: '这份全文已在资料库中，请核对并合并，已有记录保持不变。' }; });
      await workspace.flushSave();
    } catch (error) {
      if (generation === workspace.getGeneration() && workspace.getState().saveStatus === 'error') throw error;
      if (!canApply()) return;
      workspace.updateData(data => { data.documents[documentId].acquisition = { status: 'error', url, message: error instanceof Error ? error.message : '全文获取失败，可稍后重试或添加 PDF。' }; });
      await workspace.flushSave();
    }
  })().finally(() => { acquiring.delete(key); });
  acquiring.set(key, operation);
  return operation;
}
