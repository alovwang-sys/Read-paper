import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BookOpen, FileText, Layers, Network, Pin, X } from 'lucide-react';
import type { ResourceRef, Session } from '../domain/types';
import './resource-tabs.css';

type Props = {
  preview?: { title: string; onClose: () => void };
  leading?: { title: string; selected: boolean; onOpen: () => void };
  items: ResourceRef[];
  active: Session['active'];
  pinnedIds: string[];
  title: (ref: ResourceRef) => string;
  onOpen: (ref: ResourceRef) => void;
  onClose: (ref: ResourceRef) => void;
  onPin: (ref: ResourceRef) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
};
const keyOf = (ref: { kind: string; id: string }) => `${ref.kind}:${ref.id}`;

export function ResourceTabs({ preview, leading, items, active, pinnedIds, title, onOpen, onClose, onPin, onMove }: Props) {
  const leadingButton = useRef<HTMLButtonElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [dragOver, setDragOver] = useState<string>();
  const selected = preview ? 'source-preview' : keyOf(active);
  const selectedIndex = items.findIndex(item => keyOf(item) === selected);
  useEffect(() => {
    buttons.current.get(selected)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected, items.length]);

  function select(index: number) {
    const item = items[index];
    if (!item) return;
    onOpen(item);
    buttons.current.get(keyOf(item))?.focus();
  }
  function selectLeading() { leading?.onOpen(); leadingButton.current?.focus(); }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const item = items[index];
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (event.altKey) {
        if (next >= 0 && next < items.length) onMove(index, next);
      } else if (leading && (next < 0 || next >= items.length)) selectLeading();
      else select((next + items.length) % items.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (event.key === 'Home' && leading) selectLeading();
      else select(event.key === 'Home' ? 0 : items.length - 1);
    } else if (event.key === 'Delete' && item.kind !== 'research') {
      event.preventDefault();
      onClose(item);
      const next = items[index + 1] ?? items[index - 1];
      if (next) buttons.current.get(keyOf(next))?.focus();
    }
  }

  if (!items.length && !leading) return null;
  return (
    <div className="resource-tabs" role="tablist" aria-label="中央资源标签" onKeyDown={event => {
      if (event.key === 'Escape') event.stopPropagation();
    }}>
      {leading && <div className={`resource-tab research-page-tab ${leading.selected ? 'is-active' : ''}`}><button className="resource-tab-select" ref={leadingButton} role="tab" aria-selected={leading.selected} tabIndex={leading.selected ? 0 : -1} onClick={leading.onOpen} onKeyDown={event => {
        if (['ArrowLeft', 'ArrowRight', 'End', 'Home'].includes(event.key)) {
          event.preventDefault();
          if (event.key === 'Home' || !items.length) selectLeading();
          else select(event.key === 'ArrowRight' ? 0 : items.length - 1);
        }
      }}><Network size={14} /><span>{leading.title}</span></button></div>}
      {items.map((item, index) => {
        const key = keyOf(item);
        const label = title(item);
        const pinned = pinnedIds.includes(item.id);
        const Icon = item.kind === 'document' ? BookOpen : item.kind === 'card' ? Layers : item.kind === 'research' || item.kind === 'board' ? Network : FileText;
        return (
          <div
            className={`resource-tab ${selected === key ? 'is-active' : ''} ${pinned ? 'is-pinned' : ''} ${dragOver === key ? 'is-drop-target' : ''}`}
            key={key}
            draggable
            onDragStart={event => {
              event.dataTransfer.setData('application/x-papertrail-resource', key);
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={event => {
              if (!event.dataTransfer.types.includes('application/x-papertrail-resource')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDragOver(key);
            }}
            onDragLeave={() => setDragOver(undefined)}
            onDragEnd={() => setDragOver(undefined)}
            onDrop={event => {
              event.preventDefault();
              const from = items.findIndex(ref => keyOf(ref) === event.dataTransfer.getData('application/x-papertrail-resource'));
              if (from >= 0 && from !== index) onMove(from, index);
              setDragOver(undefined);
            }}
          >
            <button
              className="resource-tab-select"
              role="tab"
              aria-label={label}
              aria-selected={selected === key}
              aria-keyshortcuts="ArrowLeft ArrowRight Home End Delete Alt+ArrowLeft Alt+ArrowRight"
              tabIndex={selected === key || (!leading && selectedIndex < 0 && index === 0) ? 0 : -1}
              title={label}
              ref={element => { if (element) buttons.current.set(key, element); else buttons.current.delete(key); }}
              onClick={() => onOpen(item)}
              onKeyDown={event => keyDown(event, index)}
            >
              <Icon size={14} aria-hidden="true" />
              <span>{label}</span>
            </button>
            <button
              className="resource-tab-action resource-tab-pin"
              aria-label={`${pinned ? '取消固定' : '固定'}标签 ${label}`}
              aria-pressed={pinned}
              title={pinned ? '取消固定标签' : '固定标签'}
              onClick={() => onPin(item)}
            ><Pin size={12} aria-hidden="true" /></button>
            {item.kind !== 'research' && <button
              className="resource-tab-action"
              aria-label={`关闭标签 ${label}`}
              title="关闭标签，保留内容"
              onClick={() => onClose(item)}
            ><X size={13} aria-hidden="true" /></button>}
          </div>
        );
      })}
      {preview && <div className="resource-tab is-active"><button className="resource-tab-select" role="tab" aria-selected="true" onKeyDown={event => {
        if (event.key === 'Delete') { event.preventDefault(); preview.onClose(); }
        else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); if (items.length) select(event.key === 'ArrowRight' || event.key === 'Home' ? 0 : items.length - 1); else selectLeading(); }
      }}><BookOpen size={14} /><span>{preview.title} · 预览</span></button><button className="resource-tab-action" aria-label={`关闭预览 ${preview.title}`} onClick={preview.onClose}><X size={13} /></button></div>}
    </div>
  );
}
