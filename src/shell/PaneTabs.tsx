import { useEffect, useRef, type DragEvent, type KeyboardEvent } from 'react';
import { BookOpen, FileText, Layers, MoreHorizontal, Network, Pin, X } from 'lucide-react';
import type { PaneNode, ResourceRef } from '../domain/types';
import './pane-tabs.css';

export const PANE_TAB_MIME = 'application/x-papertrail-tab';
type Group = Extract<PaneNode, { kind: 'group' }>;

export function PaneTabs({ group, number, title, pinnedIds, menuOpen, onActivate, onClose, onMenu, onMove, onDragStart, onDragEnd, accepts, onDragOver, onDrop, dropIndex }: {
  group: Group; number: number; title: (ref: ResourceRef) => string; pinnedIds: string[]; menuOpen: boolean;
  onActivate: (tabId: string) => void; onClose: (tabId: string) => void; onMenu: (tabId?: string) => void; onMove: (tabId: string, index: number) => void;
  onDragStart: (event: DragEvent, tabId: string) => void; onDragEnd: () => void; accepts: (event: DragEvent) => boolean;
  onDragOver: (event: DragEvent, index: number) => void; onDrop: (event: DragEvent, index: number) => void; dropIndex?: number;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => { buttons.current.get(group.activeTabId ?? '')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [group.activeTabId, group.tabs.length]);
  function select(index: number) {
    const tab = group.tabs[index]; if (!tab) return;
    onActivate(tab.id); buttons.current.get(tab.id)?.focus();
  }
  function keyboard(event: KeyboardEvent, index: number) {
    const tab = group.tabs[index];
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation();
      const direction = event.key === 'ArrowLeft' ? -1 : 1, next = index + direction;
      if (event.altKey) { if (next >= 0 && next < group.tabs.length) onMove(tab.id, direction < 0 ? next : next + 1); }
      else select((next + group.tabs.length) % group.tabs.length);
    } else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); event.stopPropagation(); select(event.key === 'Home' ? 0 : group.tabs.length - 1); }
    else if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); onClose(tab.id); const next = group.tabs[index + 1] ?? group.tabs[index - 1]; if (next) buttons.current.get(next.id)?.focus(); }
    else if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); event.stopPropagation(); onMenu(tab.id); }
  }
  function insertion(event: DragEvent): number {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-pane-tab]');
    const index = group.tabs.findIndex(tab => tab.id === element?.dataset.paneTab);
    if (index < 0 || !element) return group.tabs.length;
    const bounds = element.getBoundingClientRect();
    return index + (event.clientX > bounds.left + bounds.width / 2 ? 1 : 0);
  }
  return <div className="pane-tabs" onDragOver={event => { if (accepts(event)) onDragOver(event, insertion(event)); }} onDrop={event => { if (accepts(event)) onDrop(event, insertion(event)); }}>
    <div className="pane-tablist" role="tablist" aria-label={`窗格 ${number} 标签`} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
      {group.tabs.map((tab, index) => {
        const label = title(tab.ref), active = tab.id === group.activeTabId || !group.activeTabId && index === 0;
        const duplicate = group.tabs.filter(item => item.ref.kind === tab.ref.kind && item.ref.id === tab.ref.id).length > 1;
        const location = duplicate ? tab.ref.kind === 'document' ? `PDF 第 ${(tab.reading?.pageIndex ?? 0) + 1} 页` : `视图 ${index + 1}` : '';
        const Icon = tab.ref.kind === 'document' ? BookOpen : tab.ref.kind === 'card' ? Layers : tab.ref.kind === 'board' || tab.ref.kind === 'research' ? Network : FileText;
        return <div key={tab.id} data-pane-tab={tab.id} className={`pane-tab ${active ? 'is-active' : ''} ${dropIndex === index ? 'has-drop-before' : ''}`}>
          <button ref={node => { if (node) buttons.current.set(tab.id, node); else buttons.current.delete(tab.id); }} className="pane-tab-select" role="tab" data-tab-id={tab.id} aria-label={`${label}${location ? ` · ${location}` : ''}`} aria-selected={active} tabIndex={active ? 0 : -1} title={`${label}${location ? ` · ${location}` : ''}`} draggable
            onClick={() => onActivate(tab.id)} onKeyDown={event => keyboard(event, index)} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onMenu(tab.id); }}
            onDragStart={event => onDragStart(event, tab.id)} onDragEnd={onDragEnd}>
            <Icon size={13} aria-hidden="true" /><span>{label}</span>{location && <small>{location}</small>}{pinnedIds.includes(tab.ref.id) && <Pin size={10} className="pane-tab-pin" aria-label="已固定" />}
          </button>
          <button className="pane-tab-close" aria-label={`关闭标签 ${label}`} title="关闭标签，保留内容" onClick={() => onClose(tab.id)}><X size={12} /></button>
        </div>;
      })}
      {dropIndex === group.tabs.length && <span className="pane-tab-end-drop" aria-hidden="true" />}
      {!group.tabs.length && <span className="pane-tabs-empty">空窗格</span>}
    </div>
    <button className={`pane-menu-trigger ${menuOpen ? 'is-active' : ''}`} aria-label={`窗格 ${number} 操作`} aria-haspopup="menu" aria-expanded={menuOpen} data-pane-menu-trigger={group.id} title="窗格操作" onClick={() => onMenu()}><MoreHorizontal size={17} /></button>
  </div>;
}
