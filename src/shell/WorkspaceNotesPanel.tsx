import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Layers, Search, X } from 'lucide-react';
import { useWorkspace } from '../services/workspace';
import { CardEditor } from '../features/cards/CardEditor';
import { EvidenceList } from '../features/evidence/EvidenceList';
import './workspace-notes-panel.css';

export function WorkspaceNotesPanel({ researchId, open, documentId, onClose }: { researchId: string; open: boolean; documentId?: string; onClose: () => void }) {
  const { data, session, actions } = useWorkspace();
  const [tab, setTab] = useState<'cards' | 'excerpts'>('cards');
  const [scope, setScope] = useState<'research' | 'document'>('research');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const panel = useRef<HTMLElement>(null);
  const research = data.researches[researchId];
  useLayoutEffect(() => {
    if (!open || !session.panel.open || session.panel.mode !== 'cards' || session.panel.ref?.kind !== 'card') return;
    setEditing(session.panel.ref.id);
    actions.setPanel('cards', false);
  }, [open, session.panel.open, session.panel.mode, session.panel.ref?.id]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);
  if (!research) return null;
  const currentDocument = documentId && data.documents[documentId];
  const documentScope = scope === 'document' && !!currentDocument;
  const lower = query.trim().toLocaleLowerCase();
  const cards = research.cardIds.map(id => data.cards[id]).filter(Boolean).filter(card => (!documentScope || card.evidenceIds.some(id => data.evidence[id]?.documentId === documentId)) && (!lower || `${card.title}\n${card.body}`.toLocaleLowerCase().includes(lower)));
  const evidenceIds = Object.values(data.evidence).filter(item => !item.contextOnly && research.documentIds.includes(item.documentId) && (!item.researchId || item.researchId === researchId) && (!documentScope || item.documentId === documentId) && (!lower || `${item.quote}\n${item.note ?? ''}\n${data.documents[item.documentId]?.title ?? ''}`.toLocaleLowerCase().includes(lower))).map(item => item.id);
  return <section ref={panel} className="workspace-notes-surface" role="dialog" aria-label="卡片与摘录" hidden={!open} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }} onClick={event => { const button = (event.target as HTMLElement).closest('button'); if (button?.textContent?.trim() === '定位原文') onClose(); }}>
    <header className="workspace-notes-heading"><div>{editing ? <button className="icon-button" aria-label="返回卡片与摘录" onClick={() => setEditing(undefined)}><ArrowLeft size={16}/></button> : <Layers size={16}/>}<strong>{editing ? '编辑卡片' : '卡片与摘录'}</strong></div><button className="icon-button" aria-label="关闭卡片与摘录" onClick={onClose}><X size={17}/></button></header>
    {editing ? <div className="workspace-notes-editor"><CardEditor cardId={editing}/></div> : <>
      <div className="workspace-notes-controls"><div className="workspace-notes-scope"><button aria-pressed={!documentScope} onClick={() => setScope('research')}>本研究</button><button aria-pressed={documentScope} disabled={!currentDocument} title={currentDocument ? currentDocument.title : '打开一篇论文后使用'} onClick={() => setScope('document')}>{currentDocument ? `本篇：${currentDocument.title}` : '本篇'}</button></div><label className="conversation-search"><Search size={14}/><input aria-label="搜索卡片与摘录" placeholder="搜索卡片与摘录" value={query} onChange={event => setQuery(event.target.value)}/></label><div className="workspace-notes-tabs" role="tablist" aria-label="笔记类型"><button role="tab" aria-selected={tab === 'cards'} onClick={() => setTab('cards')}>卡片 <span>{cards.length}</span></button><button role="tab" aria-selected={tab === 'excerpts'} onClick={() => setTab('excerpts')}>摘录 <span>{evidenceIds.length}</span></button></div></div>
      <div className="workspace-notes-list">{tab === 'cards' ? <>{cards.map(card => <button key={card.id} className="workspace-note-card" aria-label={`编辑卡片：${card.title}`} onClick={() => setEditing(card.id)}><strong>{card.title}</strong><p>{card.body || '还没有正文'}</p><small><BookOpen size={12}/>{card.evidenceIds.length ? `${card.evidenceIds.length} 条来源` : '待补充来源'}</small></button>)}{!cards.length && <div className="empty-state compact"><Layers size={24}/><p>{query ? '没有匹配的卡片' : '选中原文，制作第一张卡片'}</p></div>}</> : <EvidenceList evidenceIds={evidenceIds} heading="" target="main" showNote/>}</div>
    </>}
  </section>;
}
