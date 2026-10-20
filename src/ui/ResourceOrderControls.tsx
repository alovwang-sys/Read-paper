import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import type { ResearchResourceKind } from '../domain/research-order';
import { useWorkspace } from '../services/workspace';
import { startResourceDrag } from '../features/library/ResourceOpenMenu';
import { RESOURCE_ORDER_DRAG_MIME as ORDER_DRAG_MIME } from '../services/pane-context';
import './resource-order.css';

type Position = 'before' | 'after';
type OrderDrag = { researchId: string; kind: ResearchResourceKind; id: string };
let activeOrderDrag: OrderDrag | undefined;

export function useResearchResourceOrder(researchId: string, kind: ResearchResourceKind, ids: string[], enabled = true) {
  const { actions } = useWorkspace();
  const [error, setError] = useState('');
  const [drop, setDrop] = useState<{ id: string; position: Position }>();
  useEffect(() => { setError(''); setDrop(undefined); }, [researchId, kind, enabled]);
  const move = (id: string, targetId: string, position: Position) => {
    try { actions.moveResearchResource(researchId, kind, id, targetId, position); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '顺序未能保存，请重试。'); }
  };
  const accepts = (source?: OrderDrag) => enabled && source?.researchId === researchId && source.kind === kind && ids.includes(source.id);
  const positionAt = (event: DragEvent<HTMLElement>): Position => event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.getBoundingClientRect().height / 2 ? 'before' : 'after';
  const dragProps = (id: string) => ({
    draggable: true,
    'data-order-id': id,
    'data-order-drop': drop?.id === id ? drop.position : undefined,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      startResourceDrag(event, { kind, id }, { kind: 'research', researchId });
      activeOrderDrag = enabled ? { researchId, kind, id } : undefined;
      if (activeOrderDrag) {
        event.dataTransfer.setData(ORDER_DRAG_MIME, JSON.stringify(activeOrderDrag));
        event.dataTransfer.effectAllowed = 'copyMove';
      }
    },
    onDragEnd: () => { activeOrderDrag = undefined; setDrop(undefined); },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(ORDER_DRAG_MIME)) return;
      event.preventDefault(); event.stopPropagation();
      if (!accepts(activeOrderDrag) || activeOrderDrag?.id === id) { event.dataTransfer.dropEffect = 'none'; setDrop(undefined); return; }
      event.dataTransfer.dropEffect = 'move';
      setDrop({ id, position: positionAt(event) });
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(ORDER_DRAG_MIME)) return;
      event.preventDefault(); event.stopPropagation(); setDrop(undefined);
      try {
        const source = JSON.parse(event.dataTransfer.getData(ORDER_DRAG_MIME)) as OrderDrag;
        if (accepts(source) && source.id !== id) move(source.id, id, positionAt(event));
      } catch { setError('无法识别拖动内容，请重新拖动。'); }
      activeOrderDrag = undefined;
    },
  });
  return { dragProps, move, error };
}

export function ResourceOrderControls({ title, previousId, nextId, onMove, disabled = false }: {
  title: string; previousId?: string; nextId?: string; onMove: (targetId: string, position: Position) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect(), popup = menu.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - popup.width - 8, anchor.right - popup.width)), top: Math.max(8, Math.min(window.innerHeight - popup.height - 8, anchor.bottom + 3)) });
    menu.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [open]);
  return <>
    <button ref={trigger} className="resource-order-trigger" aria-label={`${title} 的排序操作`} aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={disabled ? '清除筛选后可调整顺序' : '拖动调整顺序，或点击选择上移 / 下移'} onClick={event => { event.stopPropagation(); setOpen(!open); }}><GripVertical size={14}/></button>
    {open && createPortal(<div ref={menu} className="resource-order-menu" style={position} role="menu" aria-label={`${title} 的顺序`} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Tab') { event.stopPropagation(); close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <button role="menuitem" disabled={!previousId} onClick={() => { if (previousId) onMove(previousId, 'before'); close(); }}><ArrowUp size={14}/>上移</button>
      <button role="menuitem" disabled={!nextId} onClick={() => { if (nextId) onMove(nextId, 'after'); close(); }}><ArrowDown size={14}/>下移</button>
    </div>, document.body)}
  </>;
}
