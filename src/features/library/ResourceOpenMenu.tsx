import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, MoreHorizontal } from 'lucide-react';
import type { ResourceRef, WorkspaceScope, ResourceAnchor, ReadingPosition } from '../../domain/types';
import { RESOURCE_DRAG_MIME } from '../../services/pane-context';
import { resourceTitle, useWorkspace } from '../../services/workspace';
import './resource-open-menu.css';

export function startResourceDrag(event: DragEvent<HTMLElement>, ref: ResourceRef, scope: WorkspaceScope) {
  event.dataTransfer.setData(RESOURCE_DRAG_MIME, JSON.stringify({ scope: scope.kind === 'research' ? scope.researchId : 'library', ref }));
  event.dataTransfer.effectAllowed = 'copy';
}

export function SplitDirectionItems({ onChoose, onBack }: { onChoose: (side: 'left' | 'right' | 'up' | 'down') => void; onBack?: () => void }) {
  return <>{onBack && <button role="menuitem" onClick={onBack}>返回</button>}{([['left', '向左分屏打开'], ['right', '向右分屏打开'], ['up', '向上分屏打开'], ['down', '向下分屏打开']] as const).map(([side, label]) => <button role="menuitem" key={side} onClick={() => onChoose(side)}>{label}</button>)}</>;
}

export function ResourceOpenMenu({ resource, scope, onOpened, showPreview = true, anchor, reading }: { resource: ResourceRef; scope: WorkspaceScope; onOpened?: () => void; showPreview?: boolean; anchor?: ResourceAnchor; reading?: ReadingPosition }) {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [directions, setDirections] = useState(false);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [removalError, setRemovalError] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const menu = useRef<HTMLDivElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !options.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const popup = options.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - popup.width - 8, anchor.right - popup.width)), top: Math.max(8, Math.min(window.innerHeight - popup.height - 8, anchor.bottom + 3)) });
  }, [open, directions, confirmRemoval, removalError]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !options.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    options.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open, directions, confirmRemoval]);
  const split = (side: 'left' | 'right' | 'up' | 'down') => { setOpen(false); actions.openResource(resource, { scope, target: 'main', split: side, anchor, reading }); onOpened?.(); };
  const removalLabel = scope.kind === 'research' ? '移出本研究' : '从资料库删除';
  const remove = () => {
    try {
      if (scope.kind === 'research') actions.removeDocumentFromResearch(scope.researchId, resource.id);
      else actions.deleteDocument(resource.id);
      setOpen(false);
      actions.notice(scope.kind === 'research' ? '已移出本研究，资料仍保留在资料库。' : '已从资料库删除。');
    } catch (error) { setRemovalError(error instanceof Error ? error.message : '操作失败，请重试。'); }
  };
  return <div className="resource-open-menu" ref={menu} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
    <button ref={trigger} className="icon-button" aria-label={`${resourceTitle(data, resource)} 的更多操作`} aria-haspopup="menu" aria-expanded={open} title="更多操作" onClick={() => { setDirections(false); setConfirmRemoval(false); setRemovalError(''); setOpen(!open); }}><MoreHorizontal size={16}/></button>
    {open && createPortal(<div ref={options} className="resource-open-options" style={position} role="menu" aria-label={confirmRemoval ? removalLabel : '打开位置'} onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'ArrowRight' && !directions && !confirmRemoval) { event.preventDefault(); setDirections(true); return; }
      if (event.key === 'ArrowLeft' && confirmRemoval) { event.preventDefault(); setConfirmRemoval(false); return; }
      if (event.key === 'ArrowLeft' && directions) { event.preventDefault(); setDirections(false); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      {confirmRemoval ? <>
        <p className="resource-removal-description">{scope.kind === 'research' ? '本研究的收录备注与发现记录会移除。原文、摘录和资料库保留，可重新加入；其他研究不受影响。' : '将永久删除这条资料。用于研究或已有引用的资料无法删除。'}</p>
        {removalError && <p className="resource-removal-error" role="alert">{removalError}</p>}
        <button role="menuitem" onClick={() => setConfirmRemoval(false)}>取消</button>
        <button className="resource-removal-action" role="menuitem" onClick={remove}>{scope.kind === 'research' ? '确认移出' : '确认删除'}</button>
      </> : directions ? <SplitDirectionItems onChoose={split} onBack={() => setDirections(false)}/> : <>
        <div className="resource-split-option"><button role="menuitem" onClick={() => split('right')}>在新分屏打开</button><button role="menuitem" aria-label="选择分屏方向" title="选择分屏方向" aria-haspopup="menu" onClick={() => setDirections(true)}><ChevronRight size={14}/></button></div>
        {showPreview && (resource.kind === 'document' || resource.kind === 'card') && <button role="menuitem" onClick={() => { setOpen(false); actions.openResource(resource, { scope, target: 'inspector' }); onOpened?.(); }}>在右侧预览</button>}
        {resource.kind === 'document' && <button className="resource-removal-action" role="menuitem" onClick={() => { setRemovalError(''); setConfirmRemoval(true); }}>{removalLabel}</button>}
      </>}
    </div>, document.body)}
  </div>;
}
