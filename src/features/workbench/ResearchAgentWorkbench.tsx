import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, BookOpen, ChevronDown, ImagePlus, Plus, Search, Square, X } from 'lucide-react';
import type { AIConnectionId, AIRequest, Conversation } from '../../domain/types';
import type { ResearchAgentCapability } from '../../domain/research-agent';
import { connectionLabel } from '../../services/agents';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { stopAI } from '../../services/ai';
import { applyResearchSuggestion, changeResearchAgent, clearResearchFocus, createResearchConversation, discussionAnchor, getResearchAgentCapabilities, isResearchConversation, keepResearchDraft, openResearchConversation, removeCarried, researchConversationLists, splitByRecency, EARLIER_AFTER_DAYS, stopResearchRun, submitResearchRun, undoResearchSuggestion } from '../../services/research-agent';
import { hasDrawingText, removeDrawingQuestion, setDrawingQuestionMode } from '../../services/drawing-question';
import { MarkdownContent } from '../ai/MarkdownContent';
import { SourceRecommendations } from '../ai/SourceRecommendations';
import { DrawingQuestionPreview } from './DrawingQuestionPreview';
import { CarryToConversation, DraftRoute } from './DraftRoute';
import { ResearchLiteratureResults } from './ResearchLiteratureResults';
import { VoiceInput } from '../ai/VoiceInput';
import { ChatImagePreview } from './ChatImagePreview';
import { attachChatImages, removeChatImage } from '../../services/chat-images';
import './workbench.css';

export { focusResearchResource } from '../../services/research-agent';

const statusLabels = { generating: '执行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断' };
const titleOf = (title?: string) => title?.trim() || '新会话';

export function ResearchAgentTurn({ researchId, request, index, busy }: { researchId: string; request: AIRequest; index: number; busy: boolean }) {
  const { data, actions } = useWorkspace();
  const [error, setError] = useState('');
  const run = request.researchRun, conversation = data.conversations[request.conversationId];
  const draft = run?.draftId ? data.drafts[run.draftId] : undefined;
  const failed = ['error', 'interrupted', 'stopped'].includes(request.status);
  const body = run ? request.result?.body || request.body : request.body;
  function act(operation: () => void) { try { operation(); setError(''); } catch (problem) { setError((problem as Error).message); } }
  async function retry() { setError(''); try { await submitResearchRun(researchId, request.prompt, request.id); } catch (problem) { setError((problem as Error).message); } }
  function showCitation(number: number) {
    const evidenceId = request.evidenceIds[number - 1], snapshot = request.context.find(source => source.evidenceId === evidenceId), evidence = data.evidence[evidenceId];
    const documentId = snapshot?.documentId ?? evidence?.documentId;
    if (!documentId || !data.documents[documentId]) { setError(`引用 [${number}] 的原文已缺失，请从经典工作台检查来源记录。`); return; }
    act(() => actions.openResource({ kind: 'document', id: documentId }, { scope: { kind: 'research', researchId }, target: 'inspector', anchor: evidence ? { evidenceId: evidence.id } : { pageIndex: snapshot!.pageIndex } }));
  }
  return <article className="research-agent-turn" data-request-id={request.id} aria-label={`第 ${index + 1} 轮`}>
    <section className="research-agent-user-message" aria-label="你的问题"><span className="research-agent-message-author">你</span>{request.prompt.length > 500 ? <details className="research-agent-long-question"><summary>{request.prompt.slice(0, 160)}… <span>展开完整问题</span></summary><p>{request.prompt}</p></details> : <p>{request.prompt}</p>}{!!run?.chatImages?.length && <ChatImagePreview images={run.chatImages} historical/>}{run?.drawingQuestion && <DrawingQuestionPreview question={run.drawingQuestion} historical/>}{run?.focus && <small>围绕：{run.focus.title}</small>}</section>
    <section className="research-agent-assistant-message" aria-label="Agent 的回复">
      <div className="research-agent-message-heading"><span>{connectionLabel(request.connectionId)}</span><small>{statusLabels[request.status]}{request.mode === 'demo' ? ' · 演示' : ''}{request.superseded ? ' · 已有更新版本' : ''}</small></div>
      {!!body.trim() && <MarkdownContent text={body} onCitation={showCitation}/>}
      {run?.literatureSearches?.map(search => <ResearchLiteratureResults key={search.id} request={request} search={search}/>)}
      {request.status !== 'generating' && <SourceRecommendations request={request}/>}
      {request.status === 'generating' && <p className="research-agent-progress" role="status"><span className="research-agent-pulse"/>{request.events?.at(-1)?.text || '正在连接 Agent…'}</p>}
      {draft && <button className="research-agent-artifact-link" aria-label={`打开成果：${draft.title}`} onClick={() => actions.openResource({ kind: 'draft', id: draft.id }, { scope: { kind: 'research', researchId }, target: 'main' })}><BookOpen size={19}/><span><strong>{draft.title}</strong><small>{run?.suggestion ? '修改建议 · 原稿尚未覆盖' : '独立成果 · 可编辑与核查引用'}</small></span><ArrowUpRight size={16}/></button>}
      {run?.draftId && !draft && <p className="research-agent-error">这轮关联的成果已缺失，对话记录仍然保留。</p>}
      {run?.suggestion && <div className="research-agent-suggestion"><strong>修改建议 · 原稿尚未覆盖</strong><details><summary>对比修改</summary><div className="research-agent-diff"><section><small>原稿：{run.suggestion.baseTitle}</small><MarkdownContent text={run.suggestion.baseBody}/></section><section><small>建议：{run.suggestion.title}</small><MarkdownContent text={run.suggestion.body}/></section></div></details><div className="research-agent-turn-actions"><button onClick={() => act(() => applyResearchSuggestion(request.id))}>采用建议</button><button onClick={() => act(() => keepResearchDraft(request.id))}>保留我的</button></div></div>}
      {run?.previous && <button className="research-agent-undo" aria-label="撤销本次修改" onClick={() => act(() => undoResearchSuggestion(request.id))}>撤销本次 Agent 修改</button>}
      {request.status === 'done' && conversation && discussionAnchor(conversation) && <CarryToConversation researchId={researchId} requestId={request.id} conversationId={conversation.id}/>}
      {failed && <div className="research-agent-error"><span>{request.error || '执行已中断，已有内容仍然保留。'}</span>{run && <button disabled={busy} onClick={() => void retry()}>重试</button>}</div>}
      {!failed && request.error && <p className="research-agent-error">{request.error}</p>}
      {(run?.sourceSummary || request.context.length > 0 || request.materials?.length || request.events?.length) && <details className="research-agent-scope"><summary>{run ? '本次资料与执行记录' : '当时的来源与执行记录'}</summary>{!!run?.readPages?.length && <p>实际读取 {new Set(run.readPages.map(page => page.documentId)).size} 篇、{run.readPages.length} 页；原句匹配不代表结论已核实。</p>}{run?.sourceSummary && <p>{run.sourceSummary}</p>}{request.context.map((source, sourceIndex) => <blockquote key={`${source.evidenceId}-${sourceIndex}`}><strong>{source.title} · PDF 第 {source.pageIndex + 1} 页</strong><p>{source.quote || '保存的区域证据'}</p><button onClick={() => act(() => actions.openResource({ kind: 'document', id: source.documentId }, { scope: { kind: 'research', researchId }, target: 'inspector', anchor: { pageIndex: source.pageIndex } }))}>查看这段来源</button></blockquote>)}{request.materials?.map(material => <p key={material.id}><strong>{material.title}</strong><br/>{material.text}</p>)}{request.events?.map((event, eventIndex) => <p key={event.id ?? eventIndex}>{event.text}</p>)}</details>}
      {request.nativeImported && <p className="research-agent-native-note">导入的原生记录；继续原生会话请使用经典工作台。</p>}
      {error && <p className="research-agent-error" role="alert">{error}</p>}
    </section>
  </article>;
}

export function ResearchAgentHome({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const conversation = getActiveConversation(data, researchId);
  const requests = (conversation?.requestIds ?? []).map(id => data.requests[id]).filter(Boolean);
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(false);
  const [newReply, setNewReply] = useState(false);
  const previousTurn = useRef<{ conversationId?: string; id?: string; status?: string; body?: string; searches?: string }>({});
  const restoreScroll = conversation?.researchScrollTop ?? 0;
  useLayoutEffect(() => {
    const element = scroll.current, id = conversation?.id;
    if (!element || !id) return;
    element.scrollTop = restoreScroll;
    let lastTop = element.scrollTop;
    nearBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 100;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      const top = lastTop;
      const current = actions.getState().data.conversations[id];
      if (current && current.researchScrollTop !== top) actions.updateData(next => { next.conversations[id].researchScrollTop = top; });
    };
    const onScroll = () => { lastTop = element.scrollTop; nearBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 100; if (nearBottom.current) setNewReply(false); clearTimeout(timer); timer = setTimeout(save, 150); };
    element.addEventListener('scroll', onScroll);
    return () => { clearTimeout(timer); element.removeEventListener('scroll', onScroll); save(); };
  }, [conversation?.id, researchId]);
  const latest = requests.at(-1);
  const searches = latest?.researchRun?.literatureSearches?.map(search => `${search.id}:${search.status}:${search.candidates.length}`).join('|');
  const following = nearBottom.current && (!scroll.current || scroll.current.scrollTop + scroll.current.clientHeight >= scroll.current.scrollHeight - 100);
  function showLatest() {
    const turns = scroll.current?.querySelectorAll('.research-agent-assistant-message');
    turns?.[turns.length - 1]?.scrollIntoView({ block: 'start' });
    setNewReply(false);
  }
  useLayoutEffect(() => {
    const previous = previousTurn.current;
    previousTurn.current = { conversationId: conversation?.id, id: latest?.id, status: latest?.status, body: latest?.body, searches };
    if (previous.conversationId !== conversation?.id) { setNewReply(false); return; }
    if (!latest || !scroll.current) return;
    if (previous.id !== latest.id) { showLatest(); return; }
    if (latest.status === 'done' && previous.status !== 'done' && latest.result && following) { showLatest(); return; }
    if (previous.body !== latest.body || previous.status !== latest.status || previous.searches !== searches) {
      if (following) scroll.current.scrollTop = scroll.current.scrollHeight;
      else setNewReply(true);
    }
  }, [conversation?.id, latest?.id, latest?.body, latest?.status, searches]);
  if (!data.researches[researchId]) return null;
  return <div className="research-agent-conversation-scroll" ref={scroll}><section className="research-agent-home" aria-label="当前研究会话">
    <header className="research-agent-conversation-heading"><h1>{titleOf(conversation?.title)}</h1></header>
    {!requests.length ? <div className="research-agent-welcome"><h2>你想弄清楚什么？</h2><p>描述目标，让 Agent 查找研究资料、读原文，整理出可继续编辑的成果。</p><div className="research-agent-examples" aria-label="研究目标示例">{['比较这些论文的方法、适用条件与局限，写一份带引用的研究笔记。', '先找出这些研究之间最值得继续追问的问题。'].map(prompt => <button key={prompt} onClick={() => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = prompt; }); document.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus(); }}>{prompt}<ArrowUp size={15}/></button>)}</div></div> : <div className="research-agent-messages">{requests.map((request, index) => <ResearchAgentTurn key={request.id} researchId={researchId} request={request} index={index} busy={requests.some(item => item.status === 'generating')}/>)}</div>}
    <details className="research-agent-shared"><summary>本研究的共享成果</summary><p>其他会话形成的文稿、卡片和白板也在这里。打开成果不会切换你的发送会话。</p><div>{(['drafts', 'cards', 'boards'] as const).map((view, index) => <button key={view} onClick={() => actions.openResearchView(researchId, view)}><BookOpen size={15}/>{['文稿', '卡片', '白板'][index]}<ArrowUpRight size={13}/></button>)}</div></details>
  </section>{newReply && <button className="research-agent-latest" onClick={showLatest}>查看最新回复 <ChevronDown size={14}/></button>}</div>;
}

export function ResearchAgentDock({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const conversation = getActiveConversation(data, researchId);
  const [capabilities, setCapabilities] = useState<ResearchAgentCapability[]>([]);
  const [capabilityError, setCapabilityError] = useState('');
  const [error, setError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [pendingImages, setPendingImages] = useState(0);
  const [draggingImages, setDraggingImages] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const imagePicker = useRef<HTMLInputElement>(null);
  const running = (conversation?.requestIds ?? []).map(id => data.requests[id]).find(request => request?.status === 'generating');
  const connectionId = conversation?.connectionId ?? 'codex';
  const capability = capabilities.find(item => item.id === connectionId);
  const focus = conversation?.researchFocus;
  const drawingQuestion = conversation?.drawingQuestion;
  const chatImages = conversation?.chatImages ?? [];
  const carried = conversation?.carried ?? [];
  const drawingImageBlocked = drawingQuestion?.mode === 'image' && capability?.images !== true;
  const chatImageBlocked = chatImages.length > 0 && capability?.images !== true;
  const attachmentBlocked = drawingImageBlocked || chatImageBlocked || pendingImages > 0;
  const nativeReadOnly = !!conversation && !isResearchConversation(data, conversation);
  const text = conversation?.input ?? '';
  async function detect() { setCapabilityError(''); try { setCapabilities(await getResearchAgentCapabilities()); } catch (problem) { setCapabilityError((problem as Error).message); } }
  useEffect(() => { if (!conversation) createResearchConversation(researchId, 'codex'); void detect(); }, [researchId]);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 136)}px`; } }, [text, conversation?.id]);
  useEffect(() => { setError(''); }, [conversation?.id]);
  async function send() { setError(''); try { await submitResearchRun(researchId, text); } catch (problem) { setError((problem as Error).message); } }
  async function addImages(files: File[]) {
    if (!files.length) return;
    const ownerId = conversation?.id;
    setPendingImages(count => count + 1); setError('');
    try { await attachChatImages(researchId, files); }
    catch (problem) { if (getActiveConversation(actions.getState().data, researchId)?.id === ownerId) setError((problem as Error).message); }
    finally { setPendingImages(count => count - 1); }
  }
  function changeDrawingMode(mode: 'image' | 'text') { try { setDrawingQuestionMode(researchId, mode); setError(''); } catch (problem) { setError((problem as Error).message); } }
  return <section className="research-agent-dock" aria-label="研究 Agent">
    {error && <p className="research-agent-error" role="alert">{error}</p>}
    {focus && !drawingQuestion && <div className="research-agent-focus"><span>围绕：{focus.title}</span><button aria-label="清除追问对象" onClick={() => clearResearchFocus(researchId)}><X size={14}/></button></div>}
    {/* Only while something is ready to send, so an idle chat keeps its full height. */}
    {conversation && !nativeReadOnly && (!!text.trim() || chatImages.length > 0 || !!drawingQuestion || carried.length > 0) && <DraftRoute researchId={researchId} onError={setError}/>}
    <form className={`research-agent-composer${draggingImages ? ' is-dragging-images' : ''}`} aria-busy={!!running || pendingImages > 0} onDragEnter={event => { if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.stopPropagation(); setDraggingImages(true); } }} onDragOver={event => { if (Array.from(event.dataTransfer.items).some(item => item.kind === 'file' && item.type.startsWith('image/'))) { event.preventDefault(); event.stopPropagation(); setDraggingImages(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingImages(false); }} onDrop={event => { setDraggingImages(false); const files = Array.from(event.dataTransfer.files); if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); event.stopPropagation(); if (!nativeReadOnly) void addImages(files); } }} onSubmit={event => { event.preventDefault(); if (!running && !nativeReadOnly && !attachmentBlocked) void send(); }}>
      <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden aria-label="选择图片文件" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void addImages(files); }}/>
      {!!chatImages.length && <ChatImagePreview images={chatImages} onRemove={assetId => removeChatImage(researchId, assetId)}/>}
      {!!carried.length && <ul className="research-carried" aria-label="带入的讨论结论">{carried.map(item => <li key={item.id} title={item.text.slice(0, 600)}><span>带入：{item.title}</span><button type="button" aria-label={`移除带入：${item.title}`} onClick={() => removeCarried(researchId, item.id)}><X size={12}/></button></li>)}<small>随下一问作为参考材料发送，不算原文证据</small></ul>}
      {pendingImages > 0 && <p className="research-agent-attachment-status" role="status">正在添加图片…</p>}
      {chatImageBlocked && <p className="research-agent-attachment-status" role="status">{capability ? '当前连接未确认支持图片，附件已保留；请选择支持图片的 Codex 模型并重新检测。' : '正在检测图片能力，附件已保留。'}</p>}
      {drawingQuestion && <DrawingQuestionPreview question={drawingQuestion} onRemove={() => removeDrawingQuestion(researchId)}/>}
      {drawingQuestion && <div className="research-drawing-mode"><span>未追加论文原文 · 只读分析 · 继续当前会话历史</span>{drawingImageBlocked && <p role="status">{capability ? '当前连接尚未确认支持图片，附件与输入已保留。可在下方选择研究助手并检测图片能力。' : capabilityError || '正在检测图片能力；附件与输入已保留。'}{hasDrawingText(drawingQuestion.snapshot) ? <button type="button" onClick={() => changeDrawingMode('text')}>仅发送文字和结构</button> : '这段选区没有可发送的文字，需使用支持图片的连接。'}</p>}{drawingQuestion.mode === 'text' && <p>本轮 Agent 未看图。{capability?.images === true && <button type="button" onClick={() => changeDrawingMode('image')}>改为发送图片</button>}</p>}</div>}
      <textarea ref={input} className="research-agent-input" aria-label="研究目标" placeholder={nativeReadOnly ? '原生或经典记录的草稿会保留；请到经典工作台继续…' : carried.length ? '基于带入的结论继续问…' : drawingQuestion ? '围绕这张选区图，继续问点什么…' : chatImages.length ? '补充问题，或直接发送图片…' : '在当前会话继续研究，或围绕选定内容追问…'} value={text} onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.some(file => file.type.startsWith('image/'))) { event.preventDefault(); event.stopPropagation(); if (!nativeReadOnly) void addImages(files); } }} onChange={event => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = event.target.value; }); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && !nativeReadOnly && !attachmentBlocked && (text.trim() || chatImages.length)) void send(); } }}/>
      <div className="research-agent-composer-foot"><button type="button" className="research-agent-connection" aria-label="选择研究助手" onClick={() => setConfigOpen(!configOpen)} aria-expanded={configOpen}>{connectionLabel(connectionId)}<ChevronDown size={12}/></button><span className="research-agent-permission" title="仅使用已关联研究资料；成果与修改建议在应用中保存">只读资料</span><button type="button" className="research-agent-add-image" aria-label="添加图片" title="添加图片，也可粘贴或拖入；PNG / JPEG / WebP，最多 4 张、每张 8 MB" disabled={!conversation || nativeReadOnly || pendingImages > 0} onClick={() => imagePicker.current?.click()}><ImagePlus size={17}/></button><VoiceInput key={conversation?.id} inputRef={input} disabled={nativeReadOnly}/><span className="research-agent-enter-hint">Enter 发送 · Shift Enter 换行</span>{running ? <button key="stop" type="button" className="research-agent-send" onClick={event => { event.preventDefault(); running.researchRun ? stopResearchRun(running.id) : stopAI(running.id); }} aria-label="停止研究"><Square size={16}/></button> : <button key="send" type="submit" className="research-agent-send" disabled={(!text.trim() && !chatImages.length) || !conversation || nativeReadOnly || attachmentBlocked} aria-label="开始研究"><ArrowUp size={19}/></button>}</div>
    </form>
    {nativeReadOnly && <p className="research-agent-native-note">这是原生或经典会话记录，研究工具暂不接续这段会话。<button onClick={() => actions.updateData(next => { next.agentWorkbench = false; })}>到经典工作台继续</button></p>}
    {configOpen && <div className="research-agent-config" role="dialog" aria-label="选择研究助手"><div className="research-agent-config-heading"><strong>助手</strong><button aria-label="关闭 Agent 配置" onClick={() => setConfigOpen(false)}><X size={16}/></button></div><div className="research-agent-options" role="listbox" aria-label="研究 Agent 连接">{(['codex', 'claude', 'opencode', 'model', 'demo'] as const).map(id => <button type="button" role="option" aria-selected={connectionId === id} key={id} disabled={!!running} onClick={() => { try { changeResearchAgent(researchId, id); setError(''); setConfigOpen(false); } catch (problem) { setError((problem as Error).message); } }}><span>{connectionLabel(id)}</span>{connectionId === id && <span aria-hidden="true">✓</span>}</button>)}</div><div className="research-agent-config-status"><span role="status">{capabilityError || (capability?.research ? '研究工具已连接' : capability?.detail) || '正在检测连接…'}</span><button onClick={() => void detect()}>重新检测</button></div></div>}

  </section>;
}

export function ResearchAgentHistory({ researchId, compact = false, onSelected }: { researchId: string; compact?: boolean; onSelected?: () => void }) {
  const { data, actions } = useWorkspace();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const current = getActiveConversation(data, researchId);
  const { main: conversations, discussions } = researchConversationLists(data, researchId, query);
  const discussionCount = discussions.reduce((sum, group) => sum + group.items.length, 0);
  const currentIsDiscussion = !!current && !!discussionAnchor(current);
  const [showDiscussions, setShowDiscussions] = useState(currentIsDiscussion);
  useEffect(() => { if (query || currentIsDiscussion) setShowDiscussions(true); }, [query, currentIsDiscussion]);
  // Searching lists every match flat; otherwise long-idle conversations wait under "更早".
  const { recent, earlier } = query ? { recent: conversations, earlier: [] } : splitByRecency(data, conversations);
  const currentIsEarlier = earlier.some(item => item.id === current?.id);
  const [showEarlier, setShowEarlier] = useState(currentIsEarlier);
  useEffect(() => { if (currentIsEarlier) setShowEarlier(true); }, [currentIsEarlier]);
  function act(operation: () => void) { try { operation(); setError(''); onSelected?.(); } catch (problem) { setError((problem as Error).message); } }
  function select(id: string) {
    if (!compact) { openResearchConversation(researchId, id); return; }
    actions.selectConversation(researchId, id, { surface: 'workbench' });
    actions.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; });
  }
  const row = (conversation: Conversation, label: string, kind: string) => {
    const running = conversation.requestIds.some(id => data.requests[id]?.status === 'generating');
    const active = conversation.id === current?.id;
    return <button key={conversation.id} className={`research-agent-conversation-item ${running ? 'is-running' : ''}`} aria-label={`${kind}：${label}`} title={label} aria-current={active ? 'true' : undefined} onClick={() => act(() => select(conversation.id))}><span className="conversation-status-dot" aria-label={running ? '执行中' : active ? '当前会话' : undefined}/><span className="research-agent-conversation-item-title">{label}</span></button>;
  };
  return <section className={`research-agent-history ${compact ? 'is-compact' : ''}`} aria-label="研究会话列表"><div className="research-agent-history-heading"><h2>会话</h2><button aria-label="新建会话" title="新建会话" onClick={() => act(() => { createResearchConversation(researchId, current?.connectionId ?? 'codex', { navigate: !compact }); if (compact) actions.updateData(next => { next.sessions[researchId].panel.aiView = 'chat'; }); })}><Plus size={15}/>{!compact && '新建会话'}</button></div><label className="conversation-search"><Search size={13}/><input aria-label="搜索会话" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索会话"/></label>{error && <p className="research-agent-error" role="alert">{error}</p>}{!conversations.length && !discussionCount && <p className="conversation-empty">{query ? '没有匹配的会话' : '新建会话，开始研究'}</p>}<div className="research-agent-conversation-list">{recent.map(conversation => row(conversation, titleOf(conversation.title), '打开会话'))}</div>
    {earlier.length > 0 && <details className="research-fold" open={showEarlier} onToggle={event => setShowEarlier(event.currentTarget.open)}><summary>更早（{earlier.length}）</summary><div className="research-agent-conversation-list" aria-label={`${EARLIER_AFTER_DAYS} 天以上没有活动的会话`}>{earlier.map(conversation => row(conversation, titleOf(conversation.title), '打开会话'))}</div></details>}
    {discussionCount > 0 && <details className="research-fold" open={showDiscussions} onToggle={event => setShowDiscussions(event.currentTarget.open)}><summary>讨论（{discussionCount}）</summary><div className="research-agent-conversation-list" aria-label="卡片、白板与原文讨论">{discussions.map(group => <div key={group.label + group.items[0].conversation.id} role="group" aria-label={group.label}><div className="research-discussion-group" title={group.label}>{group.label}</div>{group.items.map(item => row(item.conversation, item.label, '打开讨论'))}</div>)}</div></details>}
  </section>;
}
