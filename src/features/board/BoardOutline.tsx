import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GitBranch, Plus, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { BoardPlacement } from '../../domain/types';
import { boardDescendants, orderedBoardSiblings, prepareBoardTreePlacements } from '../../domain/board-structure';
import { layoutBoardTree } from '../../domain/board-layout';

type Props = {
  placements: BoardPlacement[];
  selected: string[];
  collapsed: string[];
  title: (item: BoardPlacement) => string;
  onLocate: (item: BoardPlacement) => void;
  onToggle: (id: string) => void;
  onReorder: (id: string, direction: -1 | 1) => void;
  onMove: (id: string, parent?: string) => void;
  onAdd: (title: string, parent?: string) => boolean;
  onClose: () => void;
};

export function BoardOutline({ placements, selected, collapsed, title, onLocate, onToggle, onReorder, onMove, onAdd, onClose }: Props) {
  const inputId = useId();
  const [newTitle, setNewTitle] = useState('');
  const [addKind, setAddKind] = useState('child');
  const active = selected.length === 1 ? placements.find(item => item.id === selected[0]) : undefined;
  const descendants = active ? boardDescendants(placements, active.id) : [];
  const siblings = active ? orderedBoardSiblings(placements, active.parentPlacementId) : [];
  const index = siblings.findIndex(item => item.id === active?.id);
  function branch(parent?: string, depth = 0) {
    return orderedBoardSiblings(placements, parent).map(item => {
      const children = placements.filter(child => child.parentPlacementId === item.id);
      const folded = collapsed.includes(item.id);
      return <li key={item.id}>
        <div className={`board-outline-row ${selected.includes(item.id) ? 'is-selected' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
          {children.length ? <button className="icon-button" aria-label={`${folded ? '展开' : '收起'}分支：${title(item)}`} aria-expanded={!folded} onClick={() => onToggle(item.id)}>{folded ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : <span className="board-outline-spacer" />}
          <button className="board-outline-title" title={title(item)} aria-label={`定位节点：${title(item)}`} aria-pressed={selected.includes(item.id)} onClick={() => onLocate(item)}>{title(item)}</button>
          {folded && <span className="board-outline-count">{boardDescendants(placements, item.id).length}</span>}
        </div>
        {!folded && children.length > 0 && <ul>{branch(item.id, depth + 1)}</ul>}
      </li>;
    });
  }
  return <aside className="board-outline" aria-label="研究图大纲">
    <div className="board-outline-heading"><strong><GitBranch size={15} />研究图大纲</strong><button className="icon-button" aria-label="关闭研究图大纲" onClick={onClose}><X size={15} /></button></div>
    <p className="board-outline-help">选择节点，再调整顺序或归属。导图同步更新。</p>
    <ul className="board-outline-list">{branch()}</ul>
    {active && <div className="board-outline-controls">
      <span className="board-outline-active" title={title(active)}>{title(active)}</span>
      <div className="board-outline-order"><button className="button" disabled={index <= 0} onClick={() => onReorder(active.id, -1)}><ArrowUp size={14} />上移</button><button className="button" disabled={index >= siblings.length - 1} onClick={() => onReorder(active.id, 1)}><ArrowDown size={14} />下移</button></div>
      <label>所属分支<select aria-label="节点所属分支" value={active.parentPlacementId ?? ''} onChange={event => onMove(active.id, event.target.value || undefined)}>
        <option value="">根节点</option>
        {placements.filter(item => item.id !== active.id && !descendants.includes(item.id)).map(item => <option key={item.id} value={item.id}>{title(item)}</option>)}
      </select></label>
      {active.parentPlacementId && <button className="button" onClick={() => onMove(active.id, placements.find(item => item.id === active.parentPlacementId)?.parentPlacementId)}>提升一级</button>}
    </div>}
    <form className="board-outline-add" onSubmit={event => { event.preventDefault(); if (!newTitle.trim()) return; if (onAdd(newTitle, active ? addKind === 'child' ? active.id : active.parentPlacementId : undefined)) setNewTitle(''); }}>
      <label htmlFor={inputId}>添加理解或主题</label>
      <input id={inputId} aria-label="新节点标题" value={newTitle} maxLength={200} placeholder="写下节点标题" onChange={event => setNewTitle(event.target.value)} />
      <div>{active && <select aria-label="新节点位置" value={addKind} onChange={event => setAddKind(event.target.value)}><option value="child">作为子节点</option><option value="sibling">作为同级节点</option></select>}<button className="button" disabled={!newTitle.trim()}><Plus size={14} />{active ? '添加节点' : '添加根节点'}</button></div>
    </form>
  </aside>;
}


export function BoardLayoutPreview({ placements, title, stale, onCancel, onConfirm }: {
  placements: BoardPlacement[];
  title: (item: BoardPlacement) => string;
  stale: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const preview = layoutBoardTree(prepareBoardTreePlacements(placements));
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="board-layout-dialog" aria-label="预览层级整理" onCancel={event => { event.preventDefault(); onCancel(); }}>
    <h3>预览层级整理</h3>
    <p>{placements.length} 个节点按明确的父子结构排列。尚无父级的资料保持为根节点；已有连线保留为关联。确认后可在大纲中调整归属与顺序。</p>
    <div className="board-layout-preview" aria-label="层级排列预览">
      <div style={{ width: Math.max(600, ...preview.map(item => item.x + 300)), height: Math.max(180, ...preview.map(item => item.y + 120)) }}>
        {preview.map(item => <div className="board-preview-node" data-preview-placement={item.id} key={item.id} style={{ left: item.x, top: item.y }}>
          {title(item)}<small>{item.parentPlacementId ? '子节点' : '根节点'}</small>
        </div>)}
      </div>
    </div>
    {stale && <p role="alert">白板已变化，请关闭并重新预览。</p>}
    <div className="board-dialog-actions"><button className="button" onClick={onCancel}>取消</button><button className="button primary" disabled={stale} onClick={onConfirm}>确认层级整理</button></div>
  </dialog>;
}
