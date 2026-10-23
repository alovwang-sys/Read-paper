import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { destinationLabel, isResearchConversation, researchConversationLists, routeResearchDraft } from '../../services/research-agent';

/** Shows where the message will go; one choice moves the unsent draft to a new thread or another research conversation. */
export function DraftRoute({ researchId, onError }: { researchId: string; onError: (message: string) => void }) {
  const { data } = useWorkspace();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = getActiveConversation(data, researchId);
  useEffect(() => { setOpen(false); }, [current?.id]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  if (!current) return null;
  const label = destinationLabel(data, current);
  const targets = researchConversationLists(data, researchId).main.filter(item => item.id !== current.id && isResearchConversation(data, item)).slice(0, 8);
  function route(target: string) {
    try {
      routeResearchDraft(researchId, target);
      onError(''); setOpen(false);
      requestAnimationFrame(() => root.current?.parentElement?.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus());
    } catch (problem) { onError((problem as Error).message); }
  }
  return <div className="research-draft-route" ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" aria-label={`将发到：${label}。改发到别处`} aria-expanded={open} title={label} onClick={() => setOpen(!open)}><span>将发到</span><strong>{label}</strong><ChevronDown size={12} /></button>
    {open && <div className="research-draft-route-menu" role="menu" aria-label="改发到">
      <button type="button" role="menuitem" onClick={() => route('new')}><Plus size={13} />{current.anchor ? `新开讨论（${current.anchor.kind === 'card' ? '这张卡片' : '本白板'}）` : '新开会话'}</button>
      {targets.length > 0 && <p>发到研究会话</p>}
      {targets.map(item => <button type="button" role="menuitem" key={item.id} title={item.title} onClick={() => route(item.id)}>{item.title?.trim() || '新会话'}</button>)}
    </div>}
  </div>;
}
