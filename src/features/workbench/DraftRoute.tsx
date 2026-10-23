import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRightLeft, ChevronDown, Plus } from 'lucide-react';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { carryToConversation, destinationLabel, isResearchConversation, researchConversationLists, routeResearchDraft } from '../../services/research-agent';

const focusComposer = () => requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus());

/** A button that opens "new thread" plus recent research conversations; shared by "将发到" and "带入会话". */
function ConversationTargetPicker({ researchId, excludeId, className, buttonLabel, menuLabel, newLabel, sectionLabel, onPick, children }: {
  researchId: string; excludeId: string; className: string; buttonLabel: string; menuLabel: string; newLabel: string; sectionLabel: string;
  onPick: (target: string) => boolean; children: ReactNode;
}) {
  const { data } = useWorkspace();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(false); }, [excludeId]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [open]);
  const targets = open ? researchConversationLists(data, researchId).main.filter(item => item.id !== excludeId && isResearchConversation(data, item)).slice(0, 8) : [];
  const pick = (target: string) => { if (onPick(target)) setOpen(false); };
  return <div className={className} ref={root} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <button type="button" aria-label={buttonLabel} title={buttonLabel} aria-expanded={open} onClick={() => setOpen(!open)}>{children}</button>
    {open && <div className="research-target-menu" role="menu" aria-label={menuLabel}>
      <button type="button" role="menuitem" onClick={() => pick('new')}><Plus size={13} />{newLabel}</button>
      {targets.length > 0 && <p>{sectionLabel}</p>}
      {targets.map(item => <button type="button" role="menuitem" key={item.id} title={item.title} onClick={() => pick(item.id)}>{item.title?.trim() || '新会话'}</button>)}
    </div>}
  </div>;
}

/** Shows where the message will go; one choice moves the unsent draft to a new thread or another research conversation. */
export function DraftRoute({ researchId, onError }: { researchId: string; onError: (message: string) => void }) {
  const { data } = useWorkspace();
  const current = getActiveConversation(data, researchId);
  if (!current) return null;
  const label = destinationLabel(data, current);
  return <ConversationTargetPicker className="research-draft-route" researchId={researchId} excludeId={current.id} buttonLabel={`将发到：${label}。改发到别处`} menuLabel="改发到"
    newLabel={current.anchor ? `新开讨论（${current.anchor.kind === 'card' ? '这张卡片' : '本白板'}）` : '新开会话'} sectionLabel="发到研究会话"
    onPick={target => { try { routeResearchDraft(researchId, target); onError(''); focusComposer(); return true; } catch (problem) { onError((problem as Error).message); return false; } }}>
    <span>将发到</span><strong>{label}</strong><ChevronDown size={12} />
  </ConversationTargetPicker>;
}

/** Carries a finished discussion answer into a research conversation as material for its next question. */
export function CarryToConversation({ researchId, requestId, conversationId }: { researchId: string; requestId: string; conversationId: string }) {
  const [error, setError] = useState('');
  return <>
    <ConversationTargetPicker className="research-carry" researchId={researchId} excludeId={conversationId} buttonLabel="带入会话：把这条回答作为参考材料带到研究会话" menuLabel="带入到"
      newLabel="带入新会话" sectionLabel="带入研究会话"
      onPick={target => { try { carryToConversation(researchId, requestId, target); setError(''); focusComposer(); return true; } catch (problem) { setError((problem as Error).message); return false; } }}>
      <ArrowRightLeft size={13} />带入会话
    </ConversationTargetPicker>
    {error && <p className="research-agent-error" role="alert">{error}</p>}
  </>;
}
