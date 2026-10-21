import { useEffect, useId, useRef, useState } from 'react';
import { Search, Sparkles, X } from 'lucide-react';
import { openBoardResearch } from '../../services/board-research';
import { resourceTitle, useWorkspace } from '../../services/workspace';
import { selectedBoardPlacements } from './board-research-selection';
import './research-actions.css';

export function BoardResearchActions({ boardId, placementIds }: { boardId: string; placementIds: string[] }) {
  const { data } = useWorkspace();
  const [pending, setPending] = useState<{ mode: 'ask' | 'literature'; ids: string[] }>();
  const [checked, setChecked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const available = selectedBoardPlacements(boardId, placementIds, Object.values(data.placements));
  useEffect(() => { if (pending) dialog.current?.showModal(); else dialog.current?.close(); }, [pending]);
  function begin(mode: 'ask' | 'literature', ids: string[]) {
    try { openBoardResearch({ boardId, placementIds: ids, mode }); setPending(undefined); setActionError(''); }
    catch (caught) { const message = caught instanceof Error ? caught.message : '暂时无法开始讨论，请重试。'; if (pending) setError(message); else setActionError(message); }
  }
  function choose(mode: 'ask' | 'literature') {
    const ids = available.map(item => item.id);
    if (ids.length === 1) { begin(mode, ids); return; }
    opener.current = document.activeElement as HTMLElement;
    setChecked(ids); setError(''); setPending({ mode, ids });
  }
  return <div className="board-research-actions" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button className="button" disabled={!available.length} onClick={() => choose('ask')}><Sparkles size={14} />问 Agent{available.length > 1 ? ` · ${available.length} 项` : ''}</button>
    <button className="button" disabled={!available.length} onClick={() => choose('literature')}><Search size={14} />找文献</button>
    {actionError && <span className="board-research-inline-error" role="alert">{actionError}</span>}
    <dialog ref={dialog} className="board-research-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); setPending(undefined); }} onClose={() => { setPending(undefined); opener.current?.focus(); }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
      <header><h2 id={titleId}>核对这次讨论的选中项</h2><button className="icon-button" aria-label="关闭选中项核对" onClick={() => setPending(undefined)}><X size={17} /></button></header>
      <p>只使用下方确认的卡片正文或文献信息。原文证据需要在对话中另行选择，不自动附送整板或全文。</p>
      <div className="board-research-members">{pending?.ids.map(id => {
        const item = data.placements[id];
        if (!item || item.boardId !== boardId) return <p key={id} className="board-research-inline-error">一项摆放已移走，请重新选择。</p>;
        const card = item.resourceRef.kind === 'card' ? data.cards[item.resourceRef.id] : undefined;
        const origin = item.researchConversationId ? data.conversations[item.researchConversationId]?.boardResearch?.origin : undefined;
        return <label key={id}><input type="checkbox" checked={checked.includes(id)} onChange={event => setChecked(current => event.target.checked ? [...current, id] : current.filter(value => value !== id))} /><span><strong>{resourceTitle(data, item.resourceRef)}</strong><small>{card ? card.body || '卡片正文为空' : '文献信息；不自动读取 PDF 全文'}</small><em>{checked[0] === id ? `原问题起点：${origin?.rootTitle ?? resourceTitle(data, item.resourceRef)}` : item.group ? `分区：${item.group}` : '当前白板摆放'}</em></span></label>;
      })}</div>
      {error && <p className="board-research-inline-error" role="alert">{error}</p>}
      <footer><span>已选 {checked.length} 项</span><button className="button" onClick={() => setPending(undefined)}>取消</button><button className="button primary" disabled={!checked.length} onClick={() => pending && begin(pending.mode, checked)}>{pending?.mode === 'literature' ? '确认并找文献' : '确认并问 Agent'}</button></footer>
    </dialog>
  </div>;
}
