import { MessageCircle } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import { anchoredConversations, openDiscussion } from '../../services/research-agent';

/** Rounds discussed on a card or board; one click opens the latest thread beside the work. */
export function DiscussionBadge({ researchId, anchor, className = 'board-discussion-badge', label = '' }: {
  researchId: string; anchor: { kind: 'card' | 'board'; id: string }; className?: string; label?: string;
}) {
  const { data } = useWorkspace();
  if (data.agentWorkbench === false) return null;
  const threads = anchoredConversations(data, researchId, anchor);
  const rounds = threads.reduce((sum, item) => sum + item.requestIds.length, 0);
  if (!rounds) return null;
  const name = anchor.kind === 'card' ? '这张卡片' : '本白板';
  return <button className={className} aria-label={`进入${name}的讨论（${rounds} 轮）`} title={`${name}的讨论，共 ${rounds} 轮问答`}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onClick={event => { event.stopPropagation(); openDiscussion(researchId, threads[0].id); }}>
    <MessageCircle size={12} />{label}{rounds}
  </button>;
}
