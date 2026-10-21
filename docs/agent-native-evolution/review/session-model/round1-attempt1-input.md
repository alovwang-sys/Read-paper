用户刚体验我们做的论文研究Agent工作台，反馈：
“中间的工作台和右侧的侧边栏的对话记录为什么展示的单条session的会话记录呢，不应该是多条会话记录的session吗，我有些不明白，你先好好反思一下和claude code再沟通一下”。

本轮只讨论，不实现。请独立批评，不要顺着我们此前方案说话。用户想AI native、少搬运，并非让所有历史消失。他的表述可能既指“会话列表应展示多个session”，也指“一个session应包含多轮消息”。请区分两种含义，结合实际代码事实，给清晰的产品层级与界面职责。

当前产品：左栏研究切换、研究工作台、最近打开资源、手动浏览。主区Home列文稿成果或打开PDF/文稿/白板；底部唯一输入，只呈当前Conversation最后一次researchRun的短答/回执。右侧点“对话记录”显示当前Conversation所有requestIds，仅conversations.length>1时有一个select，选择会话后会修改activeConversationId。新UI没有“新会话”入口。研究可以有多Conversation，Classic旧UI能新建、命名、归档。

必须核实的事实：
- 研究Research拥有资料与共享成果，多Conversation归researchId。
- Conversation有requestIds、input、connectionId；一次问答AIRequest=一轮，不是整条会话。
- domain.Session指研究界面状态（active/openItems/readers/activeConversationId），不是用户可见Agent会话。
- 研究运行每轮Codex ephemeral新thread，应用会话用最近六轮/12000字历史维持连续；不能宣称原生session无损续接。
- History.select在看旧记录时也直接selectConversation，可能把下一次发送目标切到历史conversation。
- selectConversation把panel.aiView写chat；新App兼容effect看到aiView!=history就自动转Classic。多会话切换还有真实衔接bug。
- selectAgent复用每供应商最近会话，不是按研究问题新开conversation；不能把“换模型”和“开新话题”混在一起。

请回答：1真正设计失误是什么，不要只解释实现；2一个研究/多会话/多轮/共享成果的关系，用例说明；3比较最多两种UI方案，明确中间和右侧各放什么、会话列表在哪里、唯一输入属于谁，避免重复放完整聊天；4浏览历史是否应切换写入目标；5最小修正版要做哪几件，保留研究资料/引用/人工编辑保护。中文1000字以内，不要把未实现能力说成完成。

实际关键代码（只读，供你交叉核对）：

## src/features/workbench/ResearchAgentWorkbench.tsx:13

export function ResearchAgentHome({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const research = data.researches[researchId];
  const drafts = Object.values(data.drafts).filter(draft => draft.researchId === researchId && draft.body.trim()).reverse().slice(0, 4);
  const conversation = getActiveConversation(data, researchId);
  const started = conversation?.requestIds.some(id => data.requests[id]?.researchRun);
  if (!research) return null;
  return <div className="research-agent-home">
    <span className="research-agent-eyebrow">你的研究工作台</span>
    <h1>{started || drafts.length ? '继续研究，从这里开始。' : '你想弄清楚什么？'}</h1>
    <p>说出你的目标，让 Agent 从研究资料中查找、读原文，整理出可继续编辑的成果。</p>
    {!drafts.length && <div className="research-agent-examples" aria-label="研究目标示例">
      {['比较这些论文的方法、适用条件与局限，写一份带引用的研究笔记。', '先找出这些研究之间最值得继续追问的问题。'].map(prompt => <button key={prompt} onClick={() => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = prompt; }); document.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus(); }}>{prompt}<ArrowUp size={15}/></button>)}
    </div>}
    {!!drafts.length && <section className="research-agent-recent"><h2>已有成果</h2>{drafts.map(draft => <button key={draft.id} onClick={() => actions.openResource({ kind: 'draft', id: draft.id }, { scope: { kind: 'research', researchId }, target: 'main' })}><BookOpen size={18}/><span><strong>{draft.title}</strong><small>{draft.body.replace(/[#*]/g, '').slice(0, 90)}</small></span></button>)}</section>}
    <p className="research-agent-home-note">原有论文、摘录、卡片、白板与文稿仍可从“浏览研究内容”访问。</p>
  </div>;
}

export function ResearchAgentDock({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const conversation = getActiveConversation(data, researchId);
  const [capabilities, setCapabilities] = useState<ResearchAgentCapability[]>([]);
  const [capabilityError, setCapabilityError] = useState('');
  const [error, setError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [answerOpen, setAnswerOpen] = useState(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const allRequests = (conversation?.requestIds ?? []).map(id => data.requests[id]).filter(Boolean);
  const requests = allRequests.filter(request => request.researchRun);
  const latest = requests.at(-1), running = allRequests.find(request => request.status === 'generating');
  const connectionId = conversation?.connectionId ?? 'codex';
  const capability = capabilities.find(item => item.id === connectionId);
  const focus = data.sessions[researchId]?.agentFocus;
  const text = conversation?.input ?? '';
  async function detect() { setCapabilityError(''); try { setCapabilities(await getResearchAgentCapabilities()); } catch (problem) { setCapabilityError((problem as Error).message); } }
  useEffect(() => { if (!conversation) { const created = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[created.id].connectionId = 'codex'; }); } void detect(); }, [researchId]);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(input.current.scrollHeight, 136)}px`; } }, [text, researchId]);
  useEffect(() => { setError(''); setAnswerOpen(true); }, [researchId, latest?.id]);
  async function send(retry?: AIRequest) {
    setError('');
    try { await submitResearchRun(researchId, retry?.prompt ?? text, retry?.id); }
    catch (problem) { setError((problem as Error).message); }
  }
  function act(operation: () => void) { try { operation(); setError(''); } catch (problem) { setError((problem as Error).message); } }
  function openResult(request: AIRequest) { if (request.researchRun?.draftId && data.drafts[request.researchRun.draftId]) actions.openResource({ kind: 'draft', id: request.researchRun.draftId }, { scope: { kind: 'research', researchId }, target: 'main' }); }
  const failed = latest && ['error', 'interrupted', 'stopped'].includes(latest.status);
  return <section className="research-agent-dock" aria-label="研究 Agent">
    {latest && <div className="research-agent-receipt" aria-live="polite">
      {running ? <p className="research-agent-progress"><span className="research-agent-pulse"/>{running.events?.at(-1)?.text ?? '正在连接研究 Agent…'}</p> : failed ? <div className="research-agent-error"><span>{latest.error || '上次执行已中断，输入与成果已保留。'}</span><button onClick={() => void send(latest)}>重试</button></div> : latest.status === 'done' && <>
        {latest.result ? <div className="research-agent-result-receipt"><span>{latest.body}</span><button onClick={() => openResult(latest)}>打开成果</button></div> : <><button className="research-agent-answer-toggle" onClick={() => setAnswerOpen(!answerOpen)} aria-expanded={answerOpen}><MessageSquare size={14}/><span>{answerOpen ? 'Agent 的回答' : latest.body.slice(0, 64)}</span><ChevronDown size={14}/></button>{answerOpen && <div className="research-agent-short-answer"><MarkdownContent text={latest.body}/></div>}</>}
        {!!latest.researchRun?.readPages?.length && <small className="research-agent-coverage">本次实际读取 {new Set(latest.researchRun.readPages.map(page => page.documentId)).size} 篇、{latest.researchRun.readPages.length} 页。原句匹配不代表结论已核实。</small>}
      </>}
      {latest.researchRun?.sourceSummary && <details className="research-agent-scope"><summary>本次资料范围</summary><p>{latest.researchRun.sourceSummary}</p></details>}
      {latest.researchRun?.suggestion && <div className="research-agent-suggestion"><strong>修改建议 · 原稿尚未覆盖</strong><details><summary>对比修改</summary><div className="research-agent-diff"><section><small>原稿</small><MarkdownContent text={latest.researchRun.suggestion.baseBody}/></section><section><small>建议</small><MarkdownContent text={latest.researchRun.suggestion.body}/></section></div></details><div><button onClick={() => act(() => applyResearchSuggestion(latest.id))}>采用建议</button><button onClick={() => act(() => keepResearchDraft(latest.id))}>保留我的</button></div></div>}
      {latest.researchRun?.previous && <button className="research-agent-undo" aria-label="撤销本次修改" onClick={() => act(() => undoResearchSuggestion(latest.id))}>撤销本次 Agent 修改</button>}
    </div>}
    {error && <p className="research-agent-error" role="alert">{error}</p>}
    {focus && <div className="research-agent-focus"><span>围绕：{focus.title}</span><button aria-label="清除追问对象" onClick={() => clearResearchFocus(researchId)}><X size={14}/></button></div>}
    <form className="research-agent-composer" onSubmit={event => { event.preventDefault(); if (!running) void send(); }}>
      <textarea ref={input} className="research-agent-input" aria-label="研究目标" placeholder="说出研究目标，或围绕当前内容继续追问…" value={text} maxLength={4000} onChange={event => { const current = actions.getActiveConversation(researchId); actions.updateData(next => { next.conversations[current.id].input = event.target.value; }); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && text.trim()) void send(); } }}/>
      <div className="research-agent-composer-foot"><button type="button" className="research-agent-connection" aria-label="选择研究助手" onClick={() => setConfigOpen(!configOpen)} aria-expanded={configOpen}><Settings2 size={14}/>{connectionLabel(connectionId)}<ChevronDown size={12}/></button><button type="button" className="research-agent-history-button" onClick={() => { actions.updateData(next => { next.sessions[researchId].panel.aiView = 'history'; }); actions.setPanel('ai', true); }}><MessageSquare size={14}/>对话记录</button>{running ? <button type="button" className="research-agent-send" onClick={event => { event.preventDefault(); running.researchRun ? stopResearchRun(running.id) : stopAI(running.id); }} aria-label="停止研究"><Square size={16}/></button> : <button type="submit" className="research-agent-send" disabled={!text.trim() || !conversation} aria-label="开始研究"><ArrowUp size={19}/></button>}</div>
    </form>
    {configOpen && <div className="research-agent-config"><div className="research-agent-config-heading"><strong>研究 Agent</strong><button aria-label="关闭 Agent 配置" onClick={() => setConfigOpen(false)}><X size={16}/></button></div><label>连接<select aria-label="研究 Agent 连接" value={connectionId} disabled={!!running} onChange={event => selectAgent(researchId, event.target.value as AIConnectionId)}>{(['codex', 'claude', 'opencode', 'model', 'demo'] as const).map(id => <option key={id} value={id}>{connectionLabel(id)}</option>)}</select></label><p>{capabilityError || capability?.detail || '正在检测本机研究工具能力。'}</p><p>每次委托使用独立研究运行，连续性来自应用中明确保存的历史；暂不继承原生会话、Skills 或 Plan 配置。</p>{capability?.research === false && <button onClick={() => actions.updateData(next => { next.agentWorkbench = false; })}>到经典工作台使用原有连接</button>}<button onClick={() => void detect()}>重新检测连接</button></div>}
  </section>;
}

export function ResearchAgentHistory({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const conversations = Object.values(data.conversations).filter(item => item.researchId === researchId && !item.archived);
  const current = getActiveConversation(data, researchId);
  const requests = (current?.requestIds ?? []).map(id => data.requests[id]).filter(Boolean);
  return <section className="research-agent-history" aria-label="研究对话记录"><h2>对话记录</h2>{conversations.length > 1 && <select aria-label="选择研究对话" value={current?.id ?? ''} onChange={event => actions.selectConversation(researchId, event.target.value)}>{conversations.map(conversation => <option key={conversation.id} value={conversation.id}>{conversation.title || '研究对话'}</option>)}</select>}{!requests.length && <p>提出一个研究目标后，问答与执行记录会保留在这里。</p>}{requests.map(request => <article key={request.id}><h3>{request.prompt}</h3><small>{connectionLabel(request.connectionId)} · {request.status === 'done' ? '已完成' : request.status === 'generating' ? '执行中' : '未完成'}</small>{request.researchRun?.focus && <p className="research-agent-history-focus">围绕：{request.researchRun.focus.title}</p>}<MarkdownContent text={request.researchRun && request.result ? request.body : request.body || request.error || '尚未收到回答'}/>{request.researchRun?.draftId && data.drafts[request.researchRun.draftId] && <button onClick={() => actions.openResource({ kind: 'draft', id: request.researchRun!.draftId! }, { scope: { kind: 'research', researchId }, target: 'main' })}>打开成果：{data.drafts[request.researchRun.draftId].title}</button>}{request.researchRun?.sourceSummary && <details><summary>提交时的资料范围</summary><p>{request.researchRun.sourceSummary}</p>{request.researchRun.readPages?.map(page => <small key={`${page.documentId}-${page.pageIndex}`}>{data.documents[page.documentId]?.title ?? '来源已缺失'} · PDF 第 {page.pageIndex + 1} 页<br/></small>)}</details>}{request.error && <p className="research-agent-error">{request.error}</p>}</article>)}</section>;
}

## src/services/workspace.ts:577
  createConversation(researchId: string): string {
    const id = uid('conversation');
    workspace.updateData(data => {
      if (!data.researches[researchId]) throw new Error('研究不存在。');
      const current = getActiveConversation(data, researchId);
      const connectionId = current?.connectionId ?? (data.sessions[researchId].panel.aiMode === 'demo' ? 'demo' : 'model');
      data.conversations[id] = { id, researchId, connectionId, title: '新的阅读对话', contextIds: [], requestIds: [], input: '', historyRange: 'all', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.sessions[researchId].activeConversationId = id;
      data.sessions[researchId].panel.aiView = 'chat';
    });
    return id;
  },
  selectConversation(researchId: string, conversationId: string) {
    workspace.updateData(data => {
      const conversation = data.conversations[conversationId];
      if (!conversation || conversation.researchId !== researchId) throw new Error('会话不属于该研究。');
      conversation.connectionId ??= conversation.requestIds.map(id => data.requests[id]).filter(Boolean).at(-1)?.mode === 'demo' ? 'demo' : 'model';
      data.sessions[researchId].activeConversationId = conversationId;
      data.sessions[researchId].panel.aiView = 'chat';
      data.sessions[researchId].panel.aiMode = conversation.connectionId === 'demo' ? 'demo' : 'live';
    });
  },
  renameConversation(conversationId: string, title: string) {

## src/shell/App.tsx:145
    if (loaded && agentWorkbench && research && !session.agentWorkbenchStarted) actions.updateData(next => {
      next.sessions[research.id].panel.open = false;
      next.sessions[research.id].agentWorkbenchStarted = true;
    });
  }, [loaded, agentWorkbench, research?.id, session.agentWorkbenchStarted]);
  useEffect(() => {
    if (!agentWorkbench || !session.agentWorkbenchStarted || !session.panel.open || session.panel.mode !== 'ai' || session.panel.aiView === 'history') return;
    actions.updateData(next => { next.agentWorkbench = false; });
    actions.notice('此操作在经典工作台继续，原有对话、局部材料和输入均已保留。');
  }, [agentWorkbench, session.agentWorkbenchStarted, session.panel.open, session.panel.mode, session.panel.aiView]);
  function toggleWorkbench() {
    actions.updateData(next => {
      next.agentWorkbench = !agentEnabled;
      if (!agentEnabled && research) next.sessions[research.id].panel.open = false;
    });
  }

## src/services/research-agent.ts:149
  const conversation = workspace.getActiveConversation(researchId);
  if (conversation.requestIds.some(id => workspace.getState().data.requests[id]?.status === 'generating')) throw new Error('当前研究正在执行，请等待或停止。');
  const snapshot = structuredClone(workspace.getState().data), generation = workspace.getGeneration();
  const connectionId: AIConnectionId = conversation.connectionId ?? 'codex';
  const controller = new AbortController(), signal = controller.signal, id = uid('request');
  const previous = retryId ? snapshot.requests[retryId] : undefined;
  const selectedFocus = previous?.researchRun?.focus ?? snapshot.sessions[researchId].agentFocus;
  const focusedEntity = selectedFocus?.ref.kind === 'draft' ? snapshot.drafts[selectedFocus.ref.id] : selectedFocus?.ref.kind === 'card' ? snapshot.cards[selectedFocus.ref.id] : undefined;
  const focus = selectedFocus && { ...selectedFocus, ...(focusedEntity ? { title: focusedEntity.title.slice(0, 2000), body: focusedEntity.body.slice(0, 12000) } : {}) };
  const target = focus?.ref.kind === 'draft' ? structuredClone(snapshot.drafts[focus.ref.id]) : undefined;
  const active = JSON.stringify(snapshot.sessions[researchId].active);
  const request: AIRequest = { id, researchId, conversationId: conversation.id, connectionId, prompt: prompt.trim(), context: [], history: [], createdAt: new Date().toISOString(), status: 'generating', body: '', evidenceIds: [], purpose: 'chat', mode: 'live', ...(retryId ? { retryOf: retryId } : {}), researchRun: { ...(focus ? { focus: structuredClone(focus) } : {}) } };
  running.set(id, controller);
  workspace.updateData(data => {
    data.requests[id] = request; data.conversations[conversation.id].requestIds.push(id); data.conversations[conversation.id].connectionId = connectionId;
    data.sessions[researchId].agentWorkbenchStarted = true;
    if (!previous) delete data.sessions[researchId].agentFocus;
  });
  const current = () => workspace.getGeneration() === generation && workspace.getState().data.requests[id]?.status === 'generating';
  const progress = (text: string) => { if (current()) workspace.updateData(data => { data.requests[id].events = [{ id: uid('event'), kind: 'status', text }]; }); };
  try {
    const capabilities = await getResearchAgentCapabilities(); aborted(signal);
    const capability = capabilities.find(item => item.id === connectionId);
    if (!capability?.research) throw new Error(capability?.detail || '这个连接尚不支持研究工具。请切换 Codex，或回到经典工作台继续使用原连接。');
    const { sources, summary } = await collectResearchSources(snapshot, researchId, signal, progress, focus?.ref.kind === 'document' ? focus.ref.id : undefined);
    aborted(signal); if (!current()) return id;
    const history = conversation.requestIds.map(key => snapshot.requests[key]).filter(item => item?.status === 'done' && item.researchRun && !item.validationError).slice(-6).map(item => ({ prompt: item.prompt, body: item.result?.body ?? item.body }));
    while (history.reduce((n, item) => n + item.prompt.length + item.body.length, 0) > 12000) history.shift();
    workspace.updateData(data => {
      data.requests[id].researchRun!.sourceSummary = `${summary}附送最近 ${history.length} 轮已完成研究对话（合计不超过 12,000 字符）。${focus ? '局部对象正文最多发送前 12,000 字符。' : ''}`;