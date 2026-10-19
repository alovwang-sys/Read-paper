import { useEffect, useRef, useState } from 'react';
import { FileText, RefreshCw, Upload } from 'lucide-react';
import type { SourceDiscovery } from '../../domain/types';
import { hasFullText } from '../../domain/knowledge';
import { attachPdf } from '../../services/pdf';
import { acquireFullText, sourceRecommendation } from '../../services/sources';
import { useWorkspace } from '../../services/workspace';
import { externalSourceUrl, sourceUrl } from './SourcesView';
import { ResourceOpenMenu } from './ResourceOpenMenu';
import './library.css';
import './source-intake.css';

export function DocumentDetail({ documentId }: { documentId: string }) {
  const { data, research, actions } = useWorkspace();
  const doc = data.documents[documentId];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<string>();
  const [hiddenConflict, setHiddenConflict] = useState<string>();
  const [retrying, setRetrying] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const attaching = useRef(false);
  const conflictPanel = useRef<HTMLElement>(null);
  const errorPanel = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorPanel.current?.scrollIntoView({ block: 'nearest' });
    else if (conflict) conflictPanel.current?.scrollIntoView({ block: 'nearest' });
  }, [error, conflict]);
  if (!doc) return <div className="empty-state">这条资料已缺失。</div>;
  const attach = async (file: File | undefined) => {
    if (!file || attaching.current) return;
    attaching.current = true; setBusy(true); setError(''); setConflict(undefined); setHiddenConflict(undefined);
    try { const result = await attachPdf(documentId, file); setConflict(result.conflict?.into); }
    catch (error) { setError(error instanceof Error ? error.message : '添加失败，请重新选择 PDF。'); }
    finally { attaching.current = false; setBusy(false); }
  };
  const acquisition = doc.acquisition;
  const conflictId = conflict || acquisition?.conflictDocumentId;
  const target = conflictId && hiddenConflict !== conflictId && data.documents[conflictId];
  const researches = Object.values(data.researches).filter(research => research.documentIds.includes(documentId));
  const placements = Object.values(data.placements).filter(placement => placement.resourceRef.kind === 'document' && placement.resourceRef.id === documentId);
  const openItems = Object.values(data.sessions).reduce((count, session) => count + session.openItems.filter(ref => ref.kind === 'document' && ref.id === documentId).length, 0);
  const url = sourceUrl(doc);
  const record = research?.sourceRecords?.[documentId];
  const retry = async () => {
    setRetrying(true); setError(''); setHiddenConflict(undefined);
    try { await acquireFullText(documentId); }
    catch (error) { setError(error instanceof Error ? error.message : '获取失败，可稍后重试或手动添加 PDF。'); }
    finally { setRetrying(false); }
  };
  const openDiscovery = (discovery: SourceDiscovery) => {
    const request = data.requests[discovery.requestId ?? ''];
    if (!request) return;
    actions.openConversationSource({ researchId: request.researchId, conversationId: request.conversationId, conversationTitle: data.conversations[request.conversationId]?.title || '原研究对话', requestId: request.id, prompt: request.prompt, answer: request.body, answerEvidenceIds: [...request.evidenceIds], selection: '', context: request.context, createdAt: request.createdAt, model: request.model, connectionId: request.connectionId, generationRequestIds: [], incomplete: request.status !== 'done' || !!request.legacy || !!request.nativeImported }, { kind: 'document', id: doc.id });
  };
  return <div className="page-content document-detail" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); event.stopPropagation(); if (!hasFullText(doc)) void attach(event.dataTransfer.files[0]); }}>
    <div className="library-heading"><div><div className="eyebrow">SOURCE DETAILS</div><h1>{doc.title}</h1></div><ResourceOpenMenu resource={{ kind: 'document', id: documentId }} scope={data.scope}/></div>
    <p className="page-lead">{hasFullText(doc) ? '全文已就绪，可以开始阅读。' : acquisition?.status === 'fetching' ? '已加入 · 正在获取全文…' : doc.abstract ? '已收录 · 暂无全文，可先查看摘要。' : doc.sourceKind === 'web' ? '已收录 · 仅链接' : '资料已收下，添加 PDF 后就能阅读和摘录。'}</p>
    {!hasFullText(doc) && acquisition && <div className="source-intake-status source-acquisition-status" role={acquisition.status === 'fetching' ? 'status' : undefined}>{acquisition.status === 'fetching' && <RefreshCw size={15}/>}<p>{acquisition.message || (acquisition.status === 'fetching' ? '正在尝试获取可访问的全文。可继续阅读其他资料。' : acquisition.status === 'conflict' ? '取得的全文与已有资料发生冲突，请核对后再继续。' : '暂未取得全文，文献信息已保留。')}</p>{url && acquisition.status !== 'fetching' && <button className="text-button" disabled={retrying || busy} onClick={() => void retry()}>{retrying ? '正在获取…' : '重试获取全文'}</button>}{acquisition.status === 'conflict' && conflictId && hiddenConflict === conflictId && <button className="text-button" onClick={() => setHiddenConflict(undefined)}>查看重复资料</button>}</div>}
    {doc.abstract && <section className="source-abstract"><h2>{doc.sourceKind === 'web' ? '原网页简介' : '作者摘要'}</h2><p>{doc.abstract.text}</p><a className="text-button" href={externalSourceUrl(doc.abstract.url)} target="_blank" rel="noreferrer">摘要来源 ↗</a><p className="muted">{doc.abstract.retrievedAt && `获取于 ${new Date(doc.abstract.retrievedAt).toLocaleDateString('zh-CN')}`}</p></section>}
    {!!doc.abstractAlternatives?.length && <details className="source-abstract"><summary>其他来源的摘要</summary>{doc.abstractAlternatives.map((item, index) => <section key={index}><p>{item.text}</p><a className="text-button" href={externalSourceUrl(item.url)} target="_blank" rel="noreferrer">摘要来源 ↗</a></section>)}</details>}
    <div className="document-fields">{(['title', 'authors', 'year'] as const).map(field => <label className="field" key={field}>{field === 'title' ? '标题' : field === 'authors' ? '作者' : '年份'}<input aria-label={`资料${field === 'title' ? '标题' : field === 'authors' ? '作者' : '年份'}`} value={doc[field]} onChange={event => actions.updateData(data => { data.documents[documentId][field] = event.target.value; data.documents[documentId].updatedAt = new Date().toISOString(); })}/></label>)}</div>
    {!!doc.identifiers && <div className="source-identifiers">{Object.entries(doc.identifiers).map(([kind, value]) => <p key={kind}>{kind === 'arxiv' ? 'arXiv' : kind.toUpperCase()}：{value}</p>)}</div>}
    {url && <a className="text-button" href={url} target="_blank" rel="noreferrer">打开原链接 ↗</a>}
    {hasFullText(doc) ? <button className="primary" onClick={() => actions.openResource({ kind: 'document', id: documentId }, { scope: data.scope, target: 'main' })}><FileText size={17}/>开始阅读</button> : <>
      <button className="source-file-drop source-fulltext-drop" disabled={busy} onClick={() => input.current?.click()}><Upload size={30}/><strong>{busy ? '正在校验并保存 PDF…' : '把这篇的 PDF 拖到这里，就能开始阅读'}</strong><span>补充全文会保留这份资料及已有整理</span></button>
      <input ref={input} type="file" accept=".pdf,application/pdf" hidden aria-label="为资料选择 PDF" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void attach(file); }}/>
      <p className="muted">补齐全文后可以阅读、摘录并建立 PDF 页码引用。AI 讨论依据以实际发送的材料为准。</p>
    </>}
    {error && <p ref={errorPanel} className="source-error" role="alert">{error}<button className="text-button" onClick={() => input.current?.click()}>重新选择 PDF</button></p>}
    {target && <section ref={conflictPanel} className="source-conflict" role="region" aria-label="合并资料确认"><h2>{hasFullText(target) ? '这份 PDF 已属于' : '资料库中已有同一文献'}「{target.title}」</h2><p>合并后保留资料库中的已有条目，把下列内容转移过去，再删除当前无全文条目。</p><ul><li>研究关联：{researches.map(research => research.title).join('、') || '无'}</li><li>白板摆放：{placements.length} 处；打开的标签：{openItems} 个</li><li>标识：{Object.entries(doc.identifiers ?? {}).map(([kind, value]) => `${kind}: ${value}`).join('、') || '无'}</li><li>摘要、各研究的收录备注和发现记录一并保留</li></ul><p className="muted">已有文献信息和文件保留。</p><div className="button-row"><button className="primary" disabled={busy} onClick={async () => { setBusy(true); try { actions.mergeDocuments(documentId, target.id); await actions.flushSave(); setConflict(undefined); actions.notice('已合并资料，关联、收录备注和发现记录已保留。'); } catch (error) { setError(error instanceof Error ? error.message : '合并失败，请重试保存。'); } finally { setBusy(false); } }}>合并为一条</button><button className="button" onClick={() => { setHiddenConflict(target.id); setConflict(undefined); setError(''); }}>取消</button></div></section>}

    {research?.documentIds.includes(documentId) && <section className="source-research-record"><h2>本研究的收录记录</h2><label className="field">为什么收下这份资料<textarea aria-label="本研究收录备注" placeholder="记下它与当前研究问题的关系…" value={record?.note ?? ''} onChange={event => { const note = event.target.value, researchId = research.id; actions.updateData(data => { const current = data.researches[researchId]; current.sourceRecords ??= {}; const entry = current.sourceRecords[documentId] ??= { note: '', discoveries: [] }; entry.note = note; }); }}/></label>{!!record?.discoveries.length && <div className="source-discovery-list">{record.discoveries.map((discovery, index) => {
      const request = data.requests[discovery.requestId ?? ''];
      const title = data.conversations[discovery.conversationId ?? '']?.title;
      const recommendation = sourceRecommendation(request?.body ?? discovery.recommendation ?? '', { url: discovery.url, title: doc.title, kind: doc.sourceKind ?? 'paper', identifiers: doc.identifiers });
      return <article className="source-discovery" key={`${discovery.requestId ?? discovery.url}-${index}`}><div className="source-discovery-meta"><strong>{discovery.kind === 'ai' ? `发现于 AI 对话${title ? ` · ${title}` : ''}` : '从链接收录'}</strong><small>{new Date(discovery.createdAt).toLocaleDateString('zh-CN')}</small></div>{recommendation && <p><span className="muted">AI 推荐说明：</span>{recommendation}</p>}<div className="button-row">{request && <button className="text-button" onClick={() => openDiscovery(discovery)}>回看原问答</button>}<a className="text-button" href={externalSourceUrl(discovery.url)} target="_blank" rel="noreferrer">发现时的链接 ↗</a></div></article>;
    })}</div>}</section>}
  </div>;
}
