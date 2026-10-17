import { useState } from 'react';
import { BookOpen, Plus } from 'lucide-react';
import type { CollectionId, ResourceRef } from '../../domain/types';
import { resourceTitle, useWorkspace } from '../../services/workspace';
import { hasFullText } from '../../domain/knowledge';
import { ImportPDFButton } from '../reader/ImportPDFButton';

export function LibraryView({ collection }: { collection: CollectionId }) {
  const { data, session, actions } = useWorkspace();
  const [query, setQuery] = useState('');
  const targetResearch = session.libraryResearchId ?? Object.keys(data.researches)[0];
  const refs: ResourceRef[] = (collection === 'cards' ? Object.keys(data.cards).map(id => ({ kind: 'card' as const, id })) : Object.keys(data.documents).map(id => ({ kind: 'document' as const, id }))).filter(ref => {
    const uses = Object.values(data.researches).filter(r => ref.kind === 'card' ? r.cardIds.includes(ref.id) : r.documentIds.includes(ref.id));
    return resourceTitle(data, ref).toLowerCase().includes(query.toLowerCase()) && (session.libraryFilter === 'unassigned' ? !uses.length : session.libraryFilter === 'research' ? uses.some(r => r.id === targetResearch) : true);
  });
  function open(ref: ResourceRef) { actions.openResource(ref, { scope: { kind: 'library' }, target: 'main' }); }
  return <div className="page-content library-view">
    <div className="eyebrow">YOUR RESEARCH LIBRARY</div><div className="library-heading"><div><h1>资料库</h1><p className="page-lead">跨研究复用资料与卡片。</p></div>{collection === 'documents' ? <ImportPDFButton /> : <button className="primary" onClick={() => open({ kind: 'card', id: actions.createCard([]) })}><Plus size={15} />新建卡片</button>}</div>
    <div className="button-row" aria-label="资料库类型">{(['documents', 'cards'] as const).map(id => <button key={id} className={`button ${collection === id ? 'active' : ''}`} onClick={() => actions.openCollection(id)}>{id === 'documents' ? '资料' : '卡片'}</button>)}</div>
    <div className="library-filters"><input aria-label="筛选资料" placeholder="搜索标题…" value={query} onChange={event => setQuery(event.target.value)} /><select aria-label="资料库范围" value={session.libraryFilter ?? 'all'} onChange={event => actions.updateData(next => { next.sessions.library.libraryFilter = event.target.value as 'all' | 'unassigned' | 'research'; })}><option value="all">全部</option><option value="unassigned">未加入研究</option><option value="research">本研究</option></select><select aria-label="资料加入的研究" value={targetResearch} onChange={event => actions.updateData(next => { next.sessions.library.libraryResearchId = event.target.value; })}>{Object.values(data.researches).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select></div>
    {!refs.length && <div className="empty-state"><BookOpen /><h3>这里还没有匹配的材料</h3><p>添加资料，或换一个筛选条件。</p></div>}
    <div className="library-grid">{refs.map(ref => {
      const uses = Object.values(data.researches).filter(r => ref.kind === 'card' ? r.cardIds.includes(ref.id) : r.documentIds.includes(ref.id));
      const doc = ref.kind === 'document' ? data.documents[ref.id] : undefined;
      return <article key={`${ref.kind}:${ref.id}`} className={`library-card ${ref.kind}`}><div className="library-card-meta"><span className={`type-label ${ref.kind}`}>{doc ? hasFullText(doc) ? 'PDF PAPER' : '无全文' : 'IDEA CARD'}</span></div><button className="library-card-title" onClick={() => open(ref)}><h3>{resourceTitle(data, ref)}</h3></button><p>{doc ? `${doc.authors || '作者未记录'} · ${doc.year || '年份未记录'}${hasFullText(doc) ? ` · ${doc.pageCount} 页` : ' · 添加 PDF 后开始阅读'}` : data.cards[ref.id].body.slice(0, 130)}</p><p className="muted">用于：{uses.map(r => r.title).join(' · ') || '未加入研究'}</p><div className="library-card-footer"><button className="text-button" onClick={() => open(ref)}>打开 ↗</button>{targetResearch && <button className="button" disabled={uses.some(r => r.id === targetResearch)} onClick={() => { try { ref.kind === 'card' ? actions.associateCard(targetResearch, ref.id) : actions.associateDocument(targetResearch, ref.id); actions.notice('已加入研究'); } catch (error) { actions.notice((error as Error).message); } }}>{uses.some(r => r.id === targetResearch) ? '已在本研究' : '加入本研究'}</button>}</div></article>;
    })}</div>
  </div>;
}
