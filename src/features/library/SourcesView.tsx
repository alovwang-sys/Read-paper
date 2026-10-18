import { useEffect } from 'react';
import { BookOpen, FileText, Plus, Search } from 'lucide-react';
import type { PaperDocument } from '../../domain/types';
import { hasFullText } from '../../domain/knowledge';
import { usePaneViewState, useWorkspace } from '../../services/workspace';
import { openAddSource } from './AddSourceDialog';
import { ResourceOpenMenu, startResourceDrag } from './ResourceOpenMenu';
import './library.css';

export function externalSourceUrl(value?: string) {
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; }
  catch { return undefined; }
}
export function sourceUrl(doc: PaperDocument) {
  return externalSourceUrl(doc.identifiers?.url ?? (doc.identifiers?.doi ? `https://doi.org/${doc.identifiers.doi}` : doc.identifiers?.arxiv ? `https://arxiv.org/abs/${doc.identifiers.arxiv}` : undefined));
}

function availability(doc: PaperDocument) {
  if (hasFullText(doc)) return `${doc.pageCount} 页`;
  if (doc.acquisition?.status === 'fetching') return '正在获取全文…';
  if (doc.abstract) return '摘要 · 暂无全文';
  if (doc.sourceKind === 'web') return '仅链接';
  return '暂无全文';
}

const readingNames = { unread: '未读', reading: '在读', skimmed: '略读过', read: '读完' };
export function SourcesView({ researchId }: { researchId: string }) {
  const { data, loaded, loadError, actions, pane } = useWorkspace();
  const [query, setQuery] = usePaneViewState<string>('query', '');
  const [filter, setFilter] = usePaneViewState<string>('filter', 'all');
  const research = data.researches[researchId];
  const scope = { kind: 'research' as const, researchId };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (pane) {
        const focused = document.activeElement?.closest('[data-pane-id]')?.getAttribute('data-pane-id') ?? actions.getSession(pane.scope).layout?.focusedPaneId;
        if (focused !== pane.paneId) return;
      }
      if (event.key.toLowerCase() !== 'a' || event.metaKey || event.ctrlKey || event.altKey || event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault(); openAddSource({ scope: { kind: 'research', researchId } });
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [researchId, pane?.paneId]);
  if (loadError) return <div className="empty-state"><p role="alert">{loadError}</p><button className="button" onClick={() => void actions.load()}>重新加载</button></div>;
  if (!loaded) return <div className="empty-state" role="status">正在读取研究资料…</div>;
  if (!research) return <div className="empty-state">研究已缺失，请切换到其他研究。</div>;
  const documents = research.documentIds.map(id => data.documents[id]).filter(Boolean);
  const filtered = documents.filter(doc => `${doc.title} ${doc.authors}`.toLowerCase().includes(query.toLowerCase()) &&
    (filter === 'all' || filter === 'fulltext' && !hasFullText(doc) || filter === 'finished' && ['skimmed', 'read'].includes(doc.readingStatus) || filter === doc.readingStatus));
  const groups = [
    { label: '在读', status: ['reading'] },
    { label: '未读', status: ['unread'] },
    { label: '读过', status: ['skimmed', 'read'] },
  ];
  const open = (doc: PaperDocument) => actions.openResource({ kind: 'document', id: doc.id }, { scope, target: 'main' });
  return <div className="page-content sources-view">
    <div className="library-heading"><div><h1>资料</h1></div><button className="primary" onClick={() => openAddSource({ scope })}><Plus size={16}/>添加资料</button></div>
    <div className="library-filters"><label className="search-input"><Search size={16}/><input aria-label="搜索研究资料" placeholder="搜索标题、作者…" value={query} onChange={event => setQuery(event.target.value)}/></label><select aria-label="研究资料筛选" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部</option><option value="reading">在读</option><option value="unread">未读</option><option value="finished">读过</option><option value="fulltext">无全文 {documents.filter(doc => !hasFullText(doc)).length}</option></select></div>
    {!filtered.length ? <div className="empty-state"><BookOpen size={32}/><h3>{documents.length ? '没有匹配的资料' : '从一条线索开始'}</h3><p>{documents.length ? '换个关键词或筛选条件。' : '粘贴标识、搜索资料库，或导入 PDF。'}</p>{!documents.length && <button className="button" onClick={() => openAddSource({ scope })}><Plus size={15}/>添加资料</button>}</div> : groups.map(group => {
      const rows = filtered.filter(doc => group.status.includes(doc.readingStatus));
      return rows.length ? <section key={group.label}><div className="section-title"><h2>{group.label}</h2></div><div className="paper-list">{rows.map(doc => {
        const excerpts = Object.values(data.evidence).filter(evidence => evidence.documentId === doc.id && (!evidence.researchId || evidence.researchId === researchId));
        const cards = research.cardIds.filter(id => data.cards[id]?.evidenceIds.some(id => data.evidence[id]?.documentId === doc.id));
        const url = sourceUrl(doc);
        return <article className="paper-row source-row" key={doc.id} draggable onDragStart={event => startResourceDrag(event, { kind: 'document', id: doc.id }, scope)}><span className="paper-icon tint-0"><FileText size={21}/></span><div className="paper-details"><button className="source-title" onClick={() => open(doc)}>{doc.title}</button><small>{[doc.authors, doc.year, availability(doc)].filter(Boolean).join(' · ')}</small><small>摘录 {excerpts.length} · 卡片 {cards.length}</small>{!hasFullText(doc) && <div className="source-row-actions"><button className="text-button" onClick={() => open(doc)}>添加 PDF</button>{url && <a href={url} target="_blank" rel="noreferrer">打开原链接</a>}</div>}</div><select className="source-status" aria-label={`${doc.title} 的阅读状态`} value={doc.readingStatus} onChange={event => actions.updateData(data => { data.documents[doc.id].readingStatus = event.target.value as PaperDocument['readingStatus']; data.documents[doc.id].updatedAt = new Date().toISOString(); })}>{Object.entries(readingNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ResourceOpenMenu resource={{ kind: 'document', id: doc.id }} scope={scope}/></article>;
      })}</div></section> : null;
    })}
  </div>;
}
