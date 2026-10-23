import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Pencil, RotateCcw, Trash2, X } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import './conversation-management.css';

function ManagementDialog({ title, alert = false, closeLabel, onClose, children }: { title: string; alert?: boolean; closeLabel?: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const initial = dialog.current?.querySelector<HTMLElement>('[data-dialog-autofocus]') ?? dialog.current?.querySelector<HTMLButtonElement>('button');
    initial?.focus();
    if (initial instanceof HTMLInputElement) initial.select();
    return () => {
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLButtonElement>('.conversation-host-title')?.focus();
    };
  }, []);
  return createPortal(<div className="conversation-management-backdrop" onPointerDown={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); close.current(); }
    if (event.key !== 'Tab') return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div ref={dialog} className={`conversation-management-dialog ${alert ? 'is-confirmation' : ''}`} role={alert ? 'alertdialog' : 'dialog'} aria-modal="true" aria-labelledby={titleId}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="conversation-management-close" aria-label={closeLabel ?? (alert ? '取消删除会话' : '关闭已删除会话')} onClick={onClose}><X size={17}/></button></header>
    {children}
  </div></div>, document.body);
}

export function RenameConversationButton({ conversationId, label, className = '', text = false }: { conversationId: string; label?: string; className?: string; text?: boolean }) {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const composing = useRef(false);
  useEffect(() => { setOpen(false); setError(''); }, [conversationId]);
  const conversation = data.conversations[conversationId];
  if (!conversation || conversation.deletedAt) return null;
  const title = label ?? conversation.title?.trim() ?? '新会话';
  function save() {
    if (composing.current || !name.trim()) return;
    try { actions.renameConversation(conversationId, name); setOpen(false); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '暂时无法保存名称，请重试。'); }
  }
  return <><button type="button" className={`conversation-rename-button ${className}`} aria-label={`重命名会话：${title}`} title={`重命名：${title}`} onClick={event => { event.stopPropagation(); composing.current = false; setName(conversation.title?.trim() || title); setError(''); setOpen(true); }}><Pencil size={14}/>{text && <span>重命名</span>}</button>
    {open && <ManagementDialog title="重命名会话" closeLabel="取消重命名会话" onClose={() => setOpen(false)}><form className="conversation-rename-form" onSubmit={event => { event.preventDefault(); save(); }}><label>会话名称<input data-dialog-autofocus value={name} maxLength={120} onChange={event => setName(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}/></label>{error && <p className="conversation-management-error" role="alert">{error}</p>}<footer><button type="button" className="conversation-management-cancel" onClick={() => setOpen(false)}>取消</button><button type="submit" className="conversation-management-save" disabled={!name.trim()}>保存名称</button></footer></form></ManagementDialog>}
  </>;
}

export function DeleteConversationButton({ conversationId, label, className = '', text = false }: { conversationId: string; label?: string; className?: string; text?: boolean }) {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const conversation = data.conversations[conversationId];
  if (!conversation || conversation.deletedAt) return null;
  const title = label ?? conversation.title?.trim() ?? '新会话';
  function remove() {
    try { actions.deleteConversation(conversationId); setOpen(false); actions.notice('会话已移到“已删除”，可随时恢复。'); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '暂时无法删除，请重试。'); }
  }
  return <><button type="button" className={`conversation-delete-button ${className}`} aria-label={`删除会话：${title}`} title="删除会话" onClick={event => { event.stopPropagation(); setError(''); setOpen(true); }}><Trash2 size={14}/>{text && <span>删除</span>}</button>
    {open && <ManagementDialog title="删除会话" alert onClose={() => setOpen(false)}><div className="conversation-delete-copy"><strong>{title}</strong><p>会话将移到“已删除”，可以恢复。草稿、原文和卡片引用保留，原生助手中的记录不删除。</p></div>{error && <p className="conversation-management-error" role="alert">{error}</p>}<footer><button type="button" className="conversation-management-cancel" onClick={() => setOpen(false)}>取消</button><button type="button" className="conversation-management-danger" onClick={remove}>确认删除</button></footer></ManagementDialog>}
  </>;
}

export function DeletedConversations({ researchId, compact = false }: { researchId: string; compact?: boolean }) {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState('');
  useEffect(() => { setOpen(false); setError(''); setRestored(''); }, [researchId]);
  const deleted = Object.values(data.conversations).filter(item => item.researchId === researchId && !!item.deletedAt).sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!));
  function restore(id: string) {
    try { actions.restoreDeletedConversation(id); setError(''); setRestored('会话已恢复，历史与草稿保留。'); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '暂时无法恢复，请重试。'); }
  }
  return <><button type="button" className={`deleted-conversations-trigger ${compact ? 'is-compact' : ''}`} aria-label="已删除会话" title="已删除会话" onClick={() => { setError(''); setRestored(''); setOpen(true); }}><RotateCcw size={compact ? 14 : 13}/>{!compact && <span>已删除</span>}</button>
    {open && <ManagementDialog title="已删除会话" onClose={() => setOpen(false)}><div className="deleted-conversations-list">{deleted.length ? deleted.map(item => <div className="deleted-conversation-row" key={item.id}><MessageSquare size={15}/><span title={item.title}>{item.title?.trim() || '新会话'}</span><button type="button" aria-label={`恢复会话：${item.title?.trim() || '新会话'}`} onClick={() => restore(item.id)}><RotateCcw size={13}/>恢复</button></div>) : <div className="deleted-conversations-empty"><RotateCcw size={27}/><p>没有已删除的会话</p></div>}</div>{error && <p className="conversation-management-error" role="alert">{error}</p>}{restored && <p className="conversation-management-restored" role="status">{restored}</p>}</ManagementDialog>}
  </>;
}
