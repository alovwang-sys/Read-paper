import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Folder, Search } from 'lucide-react';
import type { Research } from '../domain/types';
import './research-switcher.css';

export function ResearchSwitcher({ researches, currentId, onSwitch }: {
  researches: Research[];
  currentId?: string;
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const current = researches.find(item => item.id === currentId);
  const title = (item: Research) => item.title.trim() || '未命名研究';
  const shown = researches.filter(item => `${title(item)} ${item.question} ${item.directory?.path ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const duplicate = (item: Research) => researches.filter(other => title(other) === title(item)).length > 1;
  const detail = (item: Research) => item.directory?.path || `${new Date(item.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} 创建 · ${item.documentIds.length} 份资料`;
  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function choose(researchId: string) {
    close(true);
    if (researchId !== currentId) onSwitch(researchId);
  }
  useEffect(() => { setOpen(false); }, [currentId]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    const items = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[data-research-id]') ?? [])];
    if (event.target === search.current && event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault(); if (shown[0]) choose(shown[0].id); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return;
    if (event.target === search.current && ['Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index < 0 ? event.key === 'ArrowUp' ? items.length - 1 : 0 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return <div ref={root} className="research-switcher-host">
    <button ref={trigger} type="button" className="research-switcher" aria-label="切换研究" data-research-id={currentId ?? ''} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} title={current ? title(current) : '全局资料库'} onPointerDown={event => { if (open) event.preventDefault(); }} onClick={() => { if (open) close(true); else { setQuery(''); setOpen(true); } }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setQuery(''); setOpen(true); }
    }}>
      <span className="research-switcher-symbol"><Folder size={17}/></span>
      <span className="research-switcher-name">{current ? title(current) : '全局资料库'}</span>
      <ChevronDown size={14} aria-hidden="true"/>
    </button>
    {open && <div ref={panel} id={id} className="research-switcher-panel" role="dialog" aria-label="切换研究" onKeyDown={keys} onMouseDown={event => {
      if (event.target instanceof Element && !event.target.closest('button, input, label')) event.preventDefault();
    }} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) close();
    }}>
      <label className="research-switcher-search"><Search size={16} aria-hidden="true"/><input ref={search} aria-label="查找研究" placeholder="查找研究…" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off"/></label>
      <div className="research-switcher-caption">研究</div>
      <div className="research-switcher-list">
        {shown.map(item => <button key={item.id} type="button" className="research-switcher-item" data-research-id={item.id} aria-current={item.id === currentId ? 'true' : undefined} tabIndex={-1} title={duplicate(item) ? `${title(item)}\n${detail(item)}` : title(item)} onClick={() => choose(item.id)}>
          <Folder size={16} aria-hidden="true"/><span><strong>{title(item)}</strong>{duplicate(item) && <small>{detail(item)}</small>}</span>{item.id === currentId && <Check size={16} className="research-switcher-check" aria-hidden="true"/>}
        </button>)}
        {!shown.length && <p className="research-switcher-empty" role="status">{researches.length ? '没有找到匹配的研究' : '还没有研究，点击“新建研究”开始。'}</p>}
      </div>
      <div className="research-switcher-hint"><span>↑↓ 选择</span><span>Enter 切换</span><span>Esc 关闭</span></div>
    </div>}
  </div>;
}
