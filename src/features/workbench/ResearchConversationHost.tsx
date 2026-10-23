import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, ListPlus, Maximize2, MessageSquare, PanelRight, PanelsTopLeft, Plus, Search, X } from 'lucide-react';
import type { Session } from '../../domain/types';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { createResearchConversation, discussionAnchor, isResearchConversation, promoteDiscussion, researchConversationLists } from '../../services/research-agent';
import { AIPanel } from '../ai/AIPanel';
import { DeleteConversationButton, DeletedConversations } from '../ai/ConversationManagement';
import { ResearchAgentDock, ResearchAgentHome } from './ResearchAgentWorkbench';

type ChatState = NonNullable<Session['agentChat']>;
export type ChatMode = ChatState['mode'];

export function ResearchConversationHost({ researchId, mode, onMode }: { researchId: string; mode: ChatMode; onMode: (mode: ChatMode) => void }) {
  const { data, session, actions } = useWorkspace();
  const current = getActiveConversation(data, researchId);
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [previewRect, setPreviewRect] = useState<ChatState['rect']>();
  const host = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; resize: boolean; rect: NonNullable<ChatState['rect']> } | undefined>(undefined);
  const rectangle = previewRect ?? session.agentChat?.rect;
  const researchChat = !current || isResearchConversation(data, current) && (current.connectionId ?? 'codex') === 'codex';
  const previousBinding = useRef({ id: current?.id, connection: current?.connectionId });
  useEffect(() => {
    const previous = previousBinding.current;
    previousBinding.current = { id: current?.id, connection: current?.connectionId };
    if (current && previous.id === current.id && previous.connection !== current.connectionId && !researchChat) actions.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; });
  }, [current?.id, current?.connectionId]);
  useEffect(() => { setPicker(false); setQuery(''); }, [current?.id, mode]);
  useEffect(() => {
    if (!picker) return;
    const outside = (event: PointerEvent) => { if ((event.target as HTMLElement).closest('.conversation-management-backdrop')) return; if (!host.current?.querySelector('.conversation-host-picker')?.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-conversation-picker]')) setPicker(false); };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, [picker]);
  function select(id: string) {
    actions.selectConversation(researchId, id, { surface: 'workbench' });
    actions.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; });
    setPicker(false);
  }
  function create() {
    createResearchConversation(researchId, current?.connectionId, { navigate: false });
    actions.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; });
    setPicker(false);
  }
  function constrain(rect: NonNullable<ChatState['rect']>) {
    const width = Math.min(Math.max(340, rect.width), window.innerWidth - 24), height = Math.min(Math.max(320, rect.height), window.innerHeight - 80);
    return { width, height, left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), top: Math.max(64, Math.min(rect.top, window.innerHeight - height - 12)) };
  }
  // Side width shares the right-panel width setting; the main area keeps at least 360px.
  function resizeSide(width: number) {
    const room = host.current?.parentElement?.getBoundingClientRect().width ?? window.innerWidth;
    const next = Math.round(Math.max(320, Math.min(room - 360, width)));
    if (next !== actions.getState().data.panelWidth) actions.updateData(state => { state.panelWidth = next; });
  }
  function persistRect(rect: NonNullable<ChatState['rect']>) { actions.updateData(next => { next.sessions[researchId].agentChat = { mode: 'float', rect }; }); }
  useEffect(() => {
    if (mode !== 'float') return;
    const resize = () => { const rect = actions.getState().data.sessions[researchId].agentChat?.rect; if (rect) persistRect(constrain(rect)); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [mode, researchId]);
  const { main: conversations, discussions } = researchConversationLists(data, researchId, query);
  return <section ref={host} className={`research-conversation-host chat-${mode}`} role="region" aria-label="当前会话" data-chat-mode={mode} hidden={mode === 'closed'} style={mode === 'float' && rectangle ? constrain(rectangle) as CSSProperties : undefined}
    onKeyDown={event => { if (event.key !== 'Escape') return; if (picker) { event.preventDefault(); event.stopPropagation(); setPicker(false); } else if (mode === 'float') { event.preventDefault(); event.stopPropagation(); onMode('closed'); } }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start || start.pointer !== event.pointerId) return;
      const x = event.clientX - start.x, y = event.clientY - start.y;
      setPreviewRect(constrain(start.resize ? { ...start.rect, width: start.rect.width + x, height: start.rect.height + y } : { ...start.rect, left: start.rect.left + x, top: start.rect.top + y }));
    }}
    onPointerUp={event => {
      if (drag.current?.pointer !== event.pointerId) return;
      const rect = previewRect ?? drag.current.rect;
      drag.current = undefined; setPreviewRect(undefined); persistRect(constrain(rect));
      if (host.current?.hasPointerCapture(event.pointerId)) host.current.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { drag.current = undefined; setPreviewRect(undefined); }}>
    <header className="conversation-host-header" tabIndex={mode === 'float' ? 0 : undefined} aria-label={mode === 'float' ? '移动聊天浮窗' : undefined} onKeyDown={event => {
      if (mode !== 'float' || event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const rect = host.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      persistRect(constrain({ left: rect.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), top: rect.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), width: rect.width, height: rect.height }));
    }} onPointerDown={event => {
      if (mode !== 'float' || event.button !== 0 || (event.target as HTMLElement).closest('button,input')) return;
      const rect = host.current!.getBoundingClientRect();
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, resize: false, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
      host.current!.setPointerCapture(event.pointerId); event.preventDefault();
    }}>
      <button className="conversation-host-title" data-conversation-picker aria-label="选择会话" aria-expanded={picker} onClick={() => setPicker(!picker)}><MessageSquare size={15}/><span>{current?.title?.trim() || '新会话'}</span><ChevronDown size={13}/></button>
      <div className="conversation-host-controls">{current && <DeleteConversationButton conversationId={current.id}/>} {current && discussionAnchor(current) && <button aria-label="升为研究会话" title="移到左栏会话列表；仍与原卡片、白板或原文关联" onClick={() => promoteDiscussion(researchId, current.id)}><ListPlus size={15}/></button>}<button aria-label="侧边聊天" title="侧边聊天" aria-pressed={mode === 'side'} onClick={() => onMode('side')}><PanelRight size={15}/></button><button aria-label="浮窗聊天" title="浮窗聊天" aria-pressed={mode === 'float'} onClick={() => onMode('float')}><PanelsTopLeft size={15}/></button><button aria-label="展开聊天" title="展开聊天" aria-pressed={mode === 'main'} onClick={() => onMode('main')}><Maximize2 size={15}/></button><button aria-label="关闭聊天" title="关闭聊天" onClick={() => onMode('closed')}><X size={16}/></button></div>
      {picker && <div className="conversation-host-picker" role="dialog" aria-label="选择会话"><label className="conversation-search"><Search size={14}/><input aria-label="查找会话" value={query} onChange={event => setQuery(event.target.value)} autoFocus placeholder="搜索会话"/></label><button className="conversation-new" onClick={create}><Plus size={15}/>开始新会话</button><div>{conversations.map(item => <button key={item.id} className="conversation-picker-row" aria-current={item.id === current?.id ? 'true' : undefined} onClick={() => select(item.id)}>{item.title?.trim() || '新会话'}</button>)}{discussions.length > 0 && <p className="conversation-picker-section">讨论</p>}{discussions.flatMap(group => group.items.map(({ conversation, label }) => <button key={conversation.id} className="conversation-picker-row" title={`${group.label} · ${label}`} aria-current={conversation.id === current?.id ? 'true' : undefined} onClick={() => select(conversation.id)}>{group.label} · {label}</button>))}{!conversations.length && !discussions.length && <p className="conversation-empty">没有匹配的会话</p>}</div><div className="conversation-picker-management"><DeletedConversations researchId={researchId}/></div></div>}
    </header>
    {mode === 'side' && <div className="resize-handle" role="separator" aria-label="调整聊天宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuenow={data.panelWidth} title="拖动调整宽度，双击恢复默认宽度" tabIndex={0}
      onDoubleClick={() => resizeSide(360)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault(); resizeSide(host.current!.getBoundingClientRect().width + (event.key === 'ArrowLeft' ? 10 : -10) * (event.shiftKey ? 4 : 1));
      }}
      onPointerDown={event => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (event.buttons === 1 && event.currentTarget.hasPointerCapture(event.pointerId)) resizeSide(host.current!.getBoundingClientRect().right - event.clientX); }}/>}
    <div className="conversation-host-body">{researchChat ? <><ResearchAgentHome researchId={researchId}/><ResearchAgentDock researchId={researchId}/></> : <AIPanel/>}</div>
    {mode === 'float' && <button className="conversation-host-resize" aria-label="调整聊天浮窗大小" title="拖动调整大小" onPointerDown={event => {
      if (event.button !== 0) return;
      const rect = host.current!.getBoundingClientRect();
      drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, resize: true, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
      host.current!.setPointerCapture(event.pointerId); event.preventDefault();
    }} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const rect = host.current!.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      persistRect(constrain({ left: rect.left, top: rect.top, width: rect.width + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), height: rect.height + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }));
    }}/>}
  </section>;
}
