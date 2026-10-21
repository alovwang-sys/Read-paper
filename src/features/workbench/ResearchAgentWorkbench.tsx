import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, BookOpen, ChevronDown, MessageSquare, Plus, Settings2, Square, X } from 'lucide-react';
import type { AIConnectionId, AIRequest } from '../../domain/types';
import type { ResearchAgentCapability } from '../../domain/research-agent';
import { connectionLabel } from '../../services/agents';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { stopAI } from '../../services/ai';
import { applyResearchSuggestion, changeResearchAgent, clearResearchFocus, createResearchConversation, getResearchAgentCapabilities, isResearchConversation, keepResearchDraft, openResearchConversation, stopResearchRun, submitResearchRun, undoResearchSuggestion } from '../../services/research-agent';
import { hasDrawingText, removeDrawingQuestion, setDrawingQuestionMode } from '../../services/drawing-question';
import { MarkdownContent } from '../ai/MarkdownContent';
import { DrawingQuestionPreview } from './DrawingQuestionPreview';
import './workbench.css';

export { focusResearchResource } from '../../services/research-agent';

const statusLabels = { generating: '执行中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断' };
const titleOf = (title?: string) => title?.trim() || '新会话';

function ResearchAgentTurn({ researchId, request, index, busy }: { researchId: string; request: AIRequest; index: number; busy: boolean }) {
  const { data, actions } = useWorkspace();
  const [error, setError] = useState('');
  const run = request.researchRun;
  const draft = run?.draftId ? data.drafts[run.draftId] : undefined;
  const failed = ['error', 'interrupted', 'stopped'].includes(request.status);
  const body = run && request.result && request.body === request.result.body ? '已整理为独立成果，可以打开后继续编辑。' : request.body;
  function act(operation: () => void) { try { operation(); setError(''); } catch (problem) { setError((problem as Error).message); } }
  async function retry() { setError(''); try { await submitResearchRun(researchId, request.prompt, request.id); } catch (problem) { setError((problem as Error).message); } }
  function showCitation(number: number) {
    const evidenceId = request.evidenceIds[number - 1], snapshot = request.context.find(source => source.evidenceId === evidenceId), evidence = data.evidence[evidenceId];
    const documentId = snapshot?.documentId ?? evidence?.documentId;
    if (!documentId || !data.documents[documentId]) { setError(`引用 [${number}] 的原文已缺失，请从经典工作台检查来源记录。`); return; }
    act(() => actions.openResource({ kind: 'document', id: documentId }, { scope: { kind: 'research', researchId }, target: 'inspector', anchor: evidence ? { evidenceId: evidence.id } : { pageIndex: snapshot!.pageIndex } }));
  }
  return <article className="research-agent-turn" aria-label={`第 ${index + 1} 轮`}>
    <section className="research-agent-user-message" aria-label="你的问题"><span className="research-agent-message-author">你</span><p>{request.prompt}</p>{run?.drawingQuestion && <DrawingQuestionPreview question={run.drawingQuestion} historical/>}{run?.focus && <small>围绕：{run.focus.title}</small>}</section>
    <section className="research-agent-assistant-message" aria-label="Agent 的回复">
      <div className="research-agent-message-heading"><span>{connectionLabel(request.connectionId)}</span><small>{statusLabels[request.status]}{request.mode === 'demo' ? ' · 演示' : ''}{request.superseded ? ' · 已有更新版本' : ''}</small></div>
      {!!body.trim() && <MarkdownContent text={body} onCitation={showCitation}/>}
      {request.status === 'generating' && <p className="research-agent-progress" role="status"><span className="research-agent-pulse"/>{request.events?.at(-1)?.text || '正在连接 Agent…'}</p>}
      {draft && <button className="research-agent-artifact-link" aria-label={`打开成果：${draft.title}`} onClick={() => actions.openResource({ kind: 'draft', id: draft.id }, { scope: { kind: 'research', researchId }, target: 'main' })}><BookOpen size={19}/><span><strong>{draft.title}</strong><small>{run?.suggestion ? '修改建议 · 原稿尚未覆盖' : '独立成果 · 可编辑与核查引用'}</small></span><ArrowUpRight size={16}/></button>}
      {run?.draftId && !draft && <p className="research-agent-error">这轮关联的成果已缺失，对话记录仍然保留。</p>}
      {run?.suggestion && <div className="research-agent-suggestion"><strong>修改建议 · 原稿尚未覆盖</strong><details><summary>对比修改</summary><div className="research-agent-diff"><section><small>原稿：{run.suggestion.baseTitle}</small><MarkdownContent text={run.suggestion.baseBody}/></section><section><small>建议：{run.suggestion.title}</small><MarkdownContent text={run.suggestion.body}/></section></div></details><div className="research-agent-turn-actions"><button onClick={() => act(() => applyResearchSuggestion(request.id))}>采用建议</button><button onClick={() => act(() => keepResearchDraft(request.id))}>保留我的</button></div></div>}
      {run?.previous && <button className="research-agent-undo" aria-label="撤销本次修改" onClick={() => act(() => undoResearchSuggestion(request.id))}>撤销本次 Agent 修改</button>}
      {failed && <div className="research-agent-error"><span>{request.error || '执行已中断，已有内容仍然保留。'}</span>{run && <button disabled={busy} onClick={() => void retry()}>重试</button>}</div>}
      {!failed && request.error && <p className="research-agent-error">{request.error}</p>}
      {!!run?.readPages?.length && <small className="research-agent-coverage">本次实际读取 {new Set(run.readPages.map(page => page.documentId)).size} 篇、{run.readPages.length} 页。原句匹配不代表结论已核实。</small>}
      {(run?.sourceSummary || request.context.length > 0 || request.materials?.length || request.events?.length) && <details className="research-agent-scope"><summary>{run ? '本次资料与执行记录' : '当时的来源与执行记录'}</summary>{run?.sourceSummary && <p>{run.sourceSummary}</p>}{request.context.map((source, sourceIndex) => <blockquote key={`${source.evidenceId}-${sourceIndex}`}><strong>{source.title} · PDF 第 {source.pageIndex + 1} 页</strong><p>{source.quote || '保存的区域证据'}</p><button onClick={() => act(() => actions.openResource({ kind: 'document', id: source.documentId }, { scope: { kind: 'research', researchId }, target: 'inspector', anchor: { pageIndex: source.pageIndex } }))}>查看这段来源</button></blockquote>)}{request.materials?.map(material => <p key={material.id}><strong>{material.title}</strong><br/>{material.text}</p>)}{request.events?.map((event, eventIndex) => <p key={event.id ?? eventIndex}>{event.text}</p>)}</details>}
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
    const onScroll = () => { lastTop = element.scrollTop; nearBottom.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 100; clearTimeout(timer); timer = setTimeout(save, 150); };
    element.addEventListener('scroll', onScroll);
    return () => { clearTimeout(timer); element.removeEventListener('scroll', onScroll); save(); };
  }, [conversation?.id, researchId]);
  const latest = requests.at(-1);
  useLayoutEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [conversation?.id, latest?.id, latest?.body, latest?.status]);
  if (!data.researches[researchId]) return null;
  return <div className="research-agent-conversation-scroll" ref={scroll}><section className="research-agent-home" aria-label="当前研究会话">
    <header className="research-agent-conversation-heading"><span className="research-agent-eyebrow">当前会话</span><h1>{titleOf(conversation?.title)}</h1><p>这里保留这个话题的完整问答；成果与研究资料在同一研究中共享。</p></header>
    {!requests.length ? <div className="research-agent-welcome"><h2>你想弄清楚什么？</h2><p>描述目标，让 Agent 查找研究资料、读原文，整理出可继续编辑的成果。</p><div className="research-agent-examples" aria-label="研究目标示例">{['比较这些论文的方法、适用条件与局限，写一份带引用的研究笔记。', '先找出这些研究之间最值得继续追问的问题。'].map(prompt => <button key={prompt} onClick={() => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = prompt; }); document.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus(); }}>{prompt}<ArrowUp size={15}/></button>)}</div></div> : <div className="research-agent-messages">{requests.map((request, index) => <ResearchAgentTurn key={request.id} researchId={researchId} request={request} index={index} busy={requests.some(item => item.status === 'generating')}/>)}</div>}
    <details className="research-agent-shared"><summary>本研究的共享成果</summary><p>其他会话形成的文稿、卡片和白板也在这里。打开成果不会切换你的发送会话。</p><div>{(['drafts', 'cards', 'boards'] as const).map((view, index) => <button key={view} onClick={() => actions.openResearchView(researchId, view)}><BookOpen size={15}/>{['文稿', '卡片', '白板'][index]}<ArrowUpRight size={13}/></button>)}</div></details>
  </section></div>;
}

export function ResearchAgentDock({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const conversation = getActiveConversation(data, researchId);
  const [capabilities, setCapabilities] = useState<ResearchAgentCapability[]>([]);
  const [capabilityError, setCapabilityError] = useState('');
  const [error, setError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const running = (conversation?.requestIds ?? []).map(id => data.requests[id]).find(request => request?.status === 'generating');
  const latest = (conversation?.requestIds ?? []).map(id => data.requests[id]).filter(Boolean).at(-1);
  const connectionId = conversation?.connectionId ?? 'codex';
  const capability = capabilities.find(item => item.id === connectionId);
  const focus = conversation?.researchFocus;
  const drawingQuestion = conversation?.drawingQuestion;
  const drawingImageBlocked = drawingQuestion?.mode === 'image' && capability?.images !== true;
  const nativeReadOnly = !!conversation && !isResearchConversation(data, conversation);
  const onConversation = data.sessions[researchId].active.kind === 'researchView' && data.sessions[researchId].active.id === 'home';
  const text = conversation?.input ?? '';
  async function detect() { setCapabilityError(''); try { setCapabilities(await getResearchAgentCapabilities()); } catch (problem) { setCapabilityError((problem as Error).message); } }
  useEffect(() => { if (!conversation) createResearchConversation(researchId, 'codex'); void detect(); }, [researchId]);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 136)}px`; } }, [text, conversation?.id]);
  useEffect(() => { setError(''); }, [conversation?.id]);
  async function send() { setError(''); try { await submitResearchRun(researchId, text); } catch (problem) { setError((problem as Error).message); } }
  function openList() { actions.updateData(next => { next.sessions[researchId].panel.aiView = 'history'; }); actions.setPanel('ai', true); }
  return <section className="research-agent-dock" aria-label="研究 Agent">
    {!onConversation && conversation && <div className="research-agent-resource-status"><span>{running ? running.events?.at(-1)?.text || '当前会话正在执行…' : latest?.status === 'done' ? '会话已有回复，可返回继续。' : '成果与当前会话的输入分别保留。'}</span></div>}
    <div className="research-agent-input-binding"><span>发送到 <strong title={titleOf(conversation?.title)}>{titleOf(conversation?.title)}</strong></span><button type="button" aria-label="会话列表" onClick={openList}><MessageSquare size={14}/>会话列表</button></div>
    {error && <p className="research-agent-error" role="alert">{error}</p>}
    {focus && !drawingQuestion && <div className="research-agent-focus"><span>围绕：{focus.title}</span><button aria-label="清除追问对象" onClick={() => clearResearchFocus(researchId)}><X size={14}/></button></div>}
    <form className="research-agent-composer" aria-busy={!!running} onSubmit={event => { event.preventDefault(); if (!running && !nativeReadOnly && !drawingImageBlocked) void send(); }}>
      {drawingQuestion && <DrawingQuestionPreview question={drawingQuestion} onRemove={() => removeDrawingQuestion(researchId)}/>}
      {drawingQuestion && <div className="research-drawing-mode"><span>未追加论文原文 · 只读分析 · 继续当前会话历史</span>{drawingImageBlocked && <p role="status">{capability ? '当前连接尚未确认支持图片，附件与输入已保留。可在下方选择研究助手并检测图片能力。' : capabilityError || '正在检测图片能力；附件与输入已保留。'}{hasDrawingText(drawingQuestion.snapshot) ? <button type="button" onClick={() => setDrawingQuestionMode(researchId, 'text')}>仅发送文字和结构</button> : '这段选区没有可发送的文字，需使用支持图片的连接。'}</p>}{drawingQuestion.mode === 'text' && <p>本轮 Agent 未看图。{capability?.images === true && <button type="button" onClick={() => setDrawingQuestionMode(researchId, 'image')}>改为发送图片</button>}</p>}</div>}
      <textarea ref={input} className="research-agent-input" aria-label="研究目标" placeholder={nativeReadOnly ? '原生或经典记录的草稿会保留；请到经典工作台继续…' : drawingQuestion ? '围绕这张选区图，继续问点什么…' : '在当前会话继续研究，或围绕选定内容追问…'} value={text} maxLength={4000} onChange={event => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = event.target.value; }); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && !nativeReadOnly && !drawingImageBlocked && text.trim()) void send(); } }}/>
      <div className="research-agent-composer-foot"><button type="button" className="research-agent-connection" aria-label="选择研究助手" onClick={() => setConfigOpen(!configOpen)} aria-expanded={configOpen}><Settings2 size={14}/>{connectionLabel(connectionId)}<ChevronDown size={12}/></button><span className="research-agent-enter-hint">Enter 发送 · Shift Enter 换行</span>{running ? <button key="stop" type="button" className="research-agent-send" onClick={event => { event.preventDefault(); running.researchRun ? stopResearchRun(running.id) : stopAI(running.id); }} aria-label="停止研究"><Square size={16}/></button> : <button key="send" type="submit" className="research-agent-send" disabled={!text.trim() || !conversation || nativeReadOnly || drawingImageBlocked} aria-label="开始研究"><ArrowUp size={19}/></button>}</div>
    </form>
    {nativeReadOnly && <p className="research-agent-native-note">这是原生或经典会话记录，研究工具暂不接续这段会话。<button onClick={() => actions.updateData(next => { next.agentWorkbench = false; })}>到经典工作台继续</button></p>}
    {configOpen && <div className="research-agent-config"><div className="research-agent-config-heading"><strong>研究 Agent</strong><button aria-label="关闭 Agent 配置" onClick={() => setConfigOpen(false)}><X size={16}/></button></div><label>连接<select aria-label="研究 Agent 连接" value={connectionId} disabled={!!running} onChange={event => { try { changeResearchAgent(researchId, event.target.value as AIConnectionId); setError(''); } catch (problem) { setError((problem as Error).message); } }}>{(['codex', 'claude', 'opencode', 'model', 'demo'] as const).map(id => <option key={id} value={id}>{connectionLabel(id)}</option>)}</select></label><p>更换助手会开始独立话题，原会话和输入保留；不会跳到另一段旧话题。</p><p>{capabilityError || capability?.detail || '正在检测本机研究工具能力。'}</p><p>研究运行通过应用中明确保存的历史延续上下文，暂不继承原生线程、Skills 或 Plan 配置。</p>{capability?.research === false && <button onClick={() => actions.updateData(next => { next.agentWorkbench = false; })}>到经典工作台使用原有连接</button>}<button onClick={() => void detect()}>重新检测连接</button></div>}
  </section>;
}

export function ResearchAgentHistory({ researchId }: { researchId: string }) {
  const { data } = useWorkspace();
  const [error, setError] = useState('');
  const current = getActiveConversation(data, researchId);
  const activityAt = (id: string) => { const item = data.conversations[id]; return item.updatedAt ?? item.requestIds.map(requestId => data.requests[requestId]).filter(Boolean).at(-1)?.createdAt ?? item.createdAt ?? ''; };
  const conversations = Object.values(data.conversations).filter(item => item.researchId === researchId && !item.archived).sort((a, b) => activityAt(b.id).localeCompare(activityAt(a.id)));
  function act(operation: () => void) { try { operation(); setError(''); } catch (problem) { setError((problem as Error).message); } }
  return <section className="research-agent-history" aria-label="研究会话列表"><div className="research-agent-history-heading"><div><h2>会话列表</h2><p>每个话题保留自己的问答与输入。</p></div><button onClick={() => act(() => { createResearchConversation(researchId, current?.connectionId ?? 'codex'); })}><Plus size={15}/>新建会话</button></div>{error && <p className="research-agent-error" role="alert">{error}</p>}{!conversations.length && <p>还没有会话。新建一个话题开始研究。</p>}<div className="research-agent-conversation-list">{conversations.map(conversation => {
    const last = conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1);
    const updatedAt = activityAt(conversation.id);
    const preview = last?.researchRun && last.result ? last.result.title : last?.body.trim() || last?.prompt || conversation.input?.trim() || (conversation.drawingQuestion ? `待发送绘图：${conversation.drawingQuestion.snapshot.boardTitle}` : '从一个研究目标开始。');
    const active = conversation.id === current?.id;
    return <button key={conversation.id} className="research-agent-conversation-item" aria-label={`打开会话：${titleOf(conversation.title)}`} aria-current={active ? 'true' : undefined} onClick={() => act(() => openResearchConversation(researchId, conversation.id))}><span className="research-agent-conversation-item-title"><strong>{titleOf(conversation.title)}</strong>{active && <small>当前会话</small>}</span><span className="research-agent-conversation-preview">{preview.replace(/[#*`]/g, '').slice(0, 100)}</span><span className="research-agent-conversation-meta"><span>{connectionLabel(conversation.connectionId)}{conversation.nativeImported || conversation.nativeSessionRef ? ' · 原生记录' : ''}{last?.status === 'generating' ? ' · 执行中' : ''}</span>{updatedAt && <time dateTime={updatedAt}>{new Date(updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</span></button>;
  })}</div></section>;
}
