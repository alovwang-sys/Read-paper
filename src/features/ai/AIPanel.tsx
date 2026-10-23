import { ChatImagePreview } from '../workbench/ChatImagePreview';
import { DrawingQuestionPreview } from '../workbench/DrawingQuestionPreview';
import { clearResearchFocus, discussionAnchor } from '../../services/research-agent';
import { removeChatImage } from '../../services/chat-images';
import { removeDrawingQuestion } from '../../services/drawing-question';
import { ResearchAgentTurn } from '../workbench/ResearchAgentWorkbench';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePlus2,
  ExternalLink,
  History,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type {
  AgentConnection,
  CodexCapabilities,
  AIConnectionId,
  AIRequest,
  CardProvenance,
  ContextSnapshot,
} from '../../domain/types';
import {
  appendAIToDraft,
  createManualCardDraft,
  demoResponder,
  generateCardDraft,
  getAIConfig,
  historyForConversation,
  originalRequestPrompt,
  provenance,
  regenerateAI,
  resumeNativeRuns,
  retryAI,
  snapshotContext,
  stopAI,
  steerNativeRun,
  submitAI,
} from '../../services/ai';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { codexSupportsImages, connectionLabel, conversationConnection, getAgents, getResearchDirectory, loadOlderProjectConversation, refreshProjectConversation, selectAgent } from '../../services/agents';
import { CardDraftEditor } from '../cards/CardDraftEditor';
import { MarkdownContent } from './MarkdownContent';
import { ConversationHistory, initialHistoryState, type ConversationHistoryState } from './ConversationHistory';
import { ResearchDirectory } from '../research/ResearchDirectory';
import { ConversationSource } from './ConversationSource';
import { AgentPicker, agentStateLabel } from './AgentPicker';
import { AgentActivity } from './AgentActivity';
import { CodexComposerTools, type CodexComposerToolsHandle } from './CodexComposerTools';
import { AgentInteractionCard } from './AgentInteractionCard';
import { NativeRunTimeline } from './NativeRunTimeline';
import { ComposerMaterials } from './ComposerMaterials';
import { VoiceInput } from './VoiceInput';
import { ReportedChanges } from './ReportedChanges';
import { SourceRecommendations } from './SourceRecommendations';
import { BoardSkillPanel } from './BoardSkillPanel';
import { BoardProposal } from './BoardProposal';
import { BoardLiterature } from './BoardLiterature';
import { BoardResearchControls, BoardResearchHeading, ResearchMaterialDetails, ResearchRequestDetails } from './BoardResearchContext';
import { boardSuggestion } from '../../services/board-intent';
import { CarryToConversation } from '../workbench/DraftRoute';
import { reparseBoardProposal } from '../../services/board-skill';
import {
  ContextDetails,
  RegionPreview,
  hasOriginalDocument,
  originalAnswerContext,
} from './SourceDetails';
import './ai.css';

function toSource(request: AIRequest, title: string): CardProvenance {
  return { ...provenance(request, ''), prompt: originalRequestPrompt(request), ...(request.codex?.model ? { codexModel: request.codex.model } : {}), conversationTitle: title, createdAt: request.createdAt, incomplete: request.status !== 'done' || !!request.legacy || !!request.nativeImported };
}

type SelectionIntent = {
  requestId: string;
  text: string;
  manual?: boolean;
  paragraphChoice?: boolean;
  regenerate?: boolean;
};

export function AIPanel() {
  const { data, research, session, actions } = useWorkspace();
  const [error, setError] = useState('');
  const [config, setConfig] =
    useState<Awaited<ReturnType<typeof getAIConfig>>>();
  const [configError, setConfigError] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [agents, setAgents] = useState<AgentConnection[]>([]);
  const [codexCatalog, setCodexCatalog] = useState<CodexCapabilities>();
  const [agentError, setAgentError] = useState('');
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [intent, setIntent] = useState<SelectionIntent>();
  const [selectedFragment, setSelectedFragment] = useState<{
    requestId: string;
    text: string;
  }>();
  const [allowNewDraft, setAllowNewDraft] = useState(false);
  const [hasNewContent, setHasNewContent] = useState(false);
  const [scopeNotice, setScopeNotice] = useState('');
  const [historyStates, setHistoryStates] = useState<Record<string, ConversationHistoryState>>({});
  const [directoryReady, setDirectoryReady] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [refreshingNative, setRefreshingNative] = useState(false);
  const [nativeRefreshError, setNativeRefreshError] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [steeringBusy, setSteeringBusy] = useState(false);
  const nativeRefreshVersion = useRef(0);
  const nativeRefreshRunning = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const codexTools = useRef<CodexComposerToolsHandle>(null);
  const closeIntent = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const atBottom = useRef(true);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const sourceBackView = useRef<'chat' | 'draft' | undefined>(undefined);
  const view = session.panel.aiView ?? 'chat';
  const conversation = research
    ? getActiveConversation(data, research.id)
    : undefined;
  const connectionId = conversation ? conversationConnection(conversation) : 'model';
  const mode = connectionId === 'demo' ? 'demo' : 'live';
  const native = connectionId !== 'demo' && connectionId !== 'model';
  const legacyNative = native && !conversation?.boardResearch && !!conversation?.nativeSessionId && !conversation.nativeSessionRef;
  const managedActive = conversation?.requestIds.some(id => data.requests[id]?.nativeRun?.managed && data.requests[id].status === 'generating');
  const nativeBlocked = native && !conversation?.boardResearch && !managedActive && (!!conversation?.nativeSessionRef && (conversation.nativeState === 'busy' || conversation.nativeCanResume !== true));
  const agent = agents.find(item => item.id === connectionId);
  const backgroundTasks = Object.values(data.requests).filter(request =>
    request.researchId === research?.id && request.conversationId !== conversation?.id && request.status === 'generating',
  );
  const requests =
    conversation?.requestIds
      .map((id) => data.requests[id])
      .filter(
        (request) =>
          request && (!request.purpose || request.purpose === 'chat'),
      ) ?? [];
  const latest = requests.at(-1);
  const generating = requests.find(
    (request) => request.status === 'generating' && !request.nativeImported,
  );
  const selectedHistory = conversation
    ? connectionId === 'codex' ? requests.filter(request => request.status === 'done' && !request.superseded && !request.validationError && !request.legacy)
      .map(request => ({ requestId: request.id, prompt: originalRequestPrompt(request), body: request.body, evidenceIds: request.evidenceIds, context: request.context })) : historyForConversation(data, conversation.id)
    : [];
  const openDrafts = conversation
    ? Object.values(data.cardDrafts).filter(
        (draft) =>
          draft.conversationId === conversation.id && draft.status !== 'saved',
      )
    : [];
  const prompt = conversation?.input ?? '';
  const missingImages =
    mode === 'live' &&
    (conversation?.contextIds.some(
      (id) => data.evidence[id]?.kind === 'region',
    ) || selectedHistory.some(turn => turn.context.some(item => item.kind === 'region' && turn.evidenceIds.includes(item.evidenceId)))) &&
    !(connectionId === 'codex' ? codexSupportsImages(codexCatalog, conversation?.codex?.model) : native ? agent?.capabilities.images : config?.images);
  const canUseAgent =
    !generating &&
    !conversation?.chatImages?.length && !conversation?.drawingQuestion &&
    (!native || (directoryReady && !legacyNative && !nativeBlocked && (!nativeRefreshError || !!conversation?.boardResearch))) &&
    (mode === 'demo' || (native ? agent?.state === 'ready' && !loadingAgents && !agentError : !!config?.configured && !configError)) &&
    !missingImages;
  const canSteer = !!prompt.trim() && !!generating?.nativeRun?.managed && !steeringBusy
    && !!(generating.nativeTurnId ?? generating.nativeRun.turnId) && generating.nativeRun.transport === 'connected'
    && ['running', 'compacting'].includes(generating.nativeRun.state) && !generating.nativeRun.pendingSteer;
  const canSend = !!prompt.trim() && canUseAgent;
  const suggestion = conversation ? boardSuggestion(data, conversation) : undefined;
  const suggestionRequestId = !conversation?.boardSuggestionDismissed
    ? conversation?.boardSuggestionRequestId ?? suggestion?.requestId : undefined;
  useEffect(() => {
    if (view !== 'chat' || !conversation || !suggestion || conversation.boardSuggestionRequestId || conversation.boardSuggestionDismissed) return;
    actions.updateData(next => {
      const current = next.conversations[conversation.id];
      if (current && !current.boardSuggestionRequestId && !current.boardSuggestionDismissed) current.boardSuggestionRequestId = suggestion.requestId;
    });
  }, [view, conversation?.id, suggestion?.requestId, conversation?.boardSuggestionRequestId, conversation?.boardSuggestionDismissed, actions]);
  const updatePanel = (
    nextView: 'chat' | 'history' | 'draft' | 'source',
    draftId?: string,
  ) =>
    actions.updateData((next) => {
      const panel =
        next.sessions[
          data.scope.kind === 'research' ? data.scope.researchId : 'library'
        ].panel;
      panel.aiView = nextView;
      if (draftId) panel.aiDraftId = draftId;
    });
  async function loadConfig() {
    setLoadingConfig(true);
    setConfigError('');
    try {
      setConfig(await getAIConfig());
    } catch {
      setConfigError(window.papertrailDesktop ? '无法连接模型服务。请检查模型连接设置后重连。' : '无法连接本地 AI 服务。请启动服务后重连。');
    } finally {
      setLoadingConfig(false);
    }
  }
  async function loadAgents() {
    setLoadingAgents(true);
    setAgentError('');
    try {
      setAgents(await getAgents());
    } catch {
      setAgents([]);
      setAgentError('无法连接本机 Agent 服务。启动本地服务后重新检查，当前输入已保留。');
    } finally {
      setLoadingAgents(false);
    }
  }
  function switchAgent(id: AIConnectionId) {
    if (!research || id === connectionId) return;
    rememberScroll();
    void execute(() => {
      selectAgent(research.id, id);
      actions.notice(`已切换到${connectionLabel(id)}。原对话、未发送输入及运行中的任务均已保留。`);
    });
  }
  useEffect(() => {
    void loadConfig();
    void loadAgents();
    return window.papertrailDesktop?.onAISettingsChanged(() => void loadConfig());
  }, []);
  useEffect(() => {
    const resume = () => { void resumeNativeRuns(); };
    resume(); window.addEventListener('focus', resume);
    return () => window.removeEventListener('focus', resume);
  }, []);
  const refreshNative = useCallback(async () => {
    if (!research || !native || nativeRefreshRunning.current) return;
    const version = nativeRefreshVersion.current;
    nativeRefreshRunning.current = true;
    setRefreshingNative(true);
    try {
      if (!research.directory) { setDirectoryReady(false); return; }
      const directory = await getResearchDirectory(research.id);
      if (version !== nativeRefreshVersion.current) return;
      setDirectoryReady(!!directory);
      setDirectoryError('');
      if (directory && conversation?.nativeSessionRef && !conversation.boardResearch && !generating) await refreshProjectConversation(research.id, conversation.id);
      if (version === nativeRefreshVersion.current) setNativeRefreshError('');
    } catch (caught) {
      if (version !== nativeRefreshVersion.current) return;
      const message = caught instanceof Error ? caught.message : '暂时无法更新原生记录，已显示的内容和输入已保留。';
      if (research.directory) setDirectoryError(message);
      setNativeRefreshError(message);
    } finally {
      if (version === nativeRefreshVersion.current) { nativeRefreshRunning.current = false; setRefreshingNative(false); }
    }
  }, [research?.id, research?.directory?.projectId, research?.directory?.path, native, conversation?.id, conversation?.nativeSessionRef, generating?.id]);
  useEffect(() => {
    nativeRefreshVersion.current++;
    nativeRefreshRunning.current = false;
    setDirectoryReady(false);
    setDirectoryError('');
    setNativeRefreshError('');
    void refreshNative();
    const onFocus = () => { void refreshNative(); };
    window.addEventListener('focus', onFocus);
    return () => { nativeRefreshVersion.current++; nativeRefreshRunning.current = false; window.removeEventListener('focus', onFocus); };
  }, [refreshNative]);
  useEffect(() => {
    if (!nativeBlocked) return;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshNative(); }, 15000);
    return () => clearInterval(timer);
  }, [nativeBlocked, refreshNative]);
  useEffect(() => {
    setError('');
    setScopeNotice('');
    setSelectedFragment(undefined);
    setIntent(undefined);
    setOlderError('');
    setLoadingOlder(false);
  }, [conversation?.id]);
  useEffect(() => {
    if (intent && !dialog.current?.open) {
      dialog.current?.showModal();
      closeIntent.current?.focus();
    } else if (!intent) dialog.current?.close();
  }, [intent]);
  useLayoutEffect(() => {
    if (view !== 'chat' || !scroll.current || !conversation) return;
    const element = scroll.current;
    element.scrollTop = conversation.scrollTop ?? element.scrollHeight;
    atBottom.current =
      element.scrollHeight - element.clientHeight - element.scrollTop < 90;
    setHasNewContent(false);
  }, [conversation?.id, view]);
  useLayoutEffect(() => {
    if (view !== 'chat' || !scroll.current) return;
    if (atBottom.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
    else if (latest?.body) setHasNewContent(true);
  }, [latest?.body, latest?.id, latest?.status, latest?.interactions?.length, latest?.nativeRun?.items.length, latest?.nativeRun?.state, view]);
  useLayoutEffect(() => {
    const element = input.current;
    if (view !== 'chat' || !element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(160, Math.max(44, element.scrollHeight))}px`;
  }, [prompt, conversation?.id, view]);
  useEffect(() => () => clearTimeout(scrollTimer.current), []);
  function rememberScroll() {
    if (!conversation || !scroll.current) return;
    clearTimeout(scrollTimer.current);
    const top = scroll.current.scrollTop,
      id = conversation.id;
    actions.updateData((next) => {
      if (next.conversations[id]) next.conversations[id].scrollTop = top;
    });
  }
  async function execute(operation: () => unknown | Promise<unknown>) {
    setError('');
    try {
      await operation();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : '操作失败，内容已保留，请重试。',
      );
    }
  }
  async function send(board?: 'create' | 'none') {
    if (!board && connectionId === 'codex' && codexTools.current?.handleSubmit()) return;
    if (!research || !conversation || !(board === 'create' ? canUseAgent : canSend)) return;
    atBottom.current = true;
    await execute(() =>
      submitAI(
        research.id,
        conversation.id,
        prompt.trim() ? prompt : '把当前对话整理成白板',
        mode === 'demo' ? demoResponder : undefined,
        board ? { board } : undefined,
      ),
    );
  }
  async function createSuggestedBoard(request: AIRequest) {
    if (!research || !conversation || !canUseAgent) return;
    actions.updateData(next => { next.conversations[conversation.id].boardSuggestionDismissed = true; });
    atBottom.current = true;
    const description = `将下面这条回答整理成关系白板，保留来源并标记待核查内容。\n问题：${originalRequestPrompt(request).slice(0, 500)}\n回答：${request.body.slice(0, 3000)}`;
    await execute(() => submitAI(research.id, conversation.id, description, mode === 'demo' ? demoResponder : undefined, { board: 'create' }));
  }
  function showSource(source: CardProvenance, back: 'chat' | 'draft') {
    if (back === 'chat') rememberScroll();
    sourceBackView.current = back;
    actions.openConversationSource(source);
  }
  function returnSource() {
    if (session.panel.sourceReturnRef) {
      actions.openResource(session.panel.sourceReturnRef, {
        scope: data.scope,
        target: 'inspector',
      });
      return;
    }
    const restoredDraft = session.panel.aiDraftId
      ? data.cardDrafts[session.panel.aiDraftId]
      : undefined;
    updatePanel(
      sourceBackView.current ??
        (restoredDraft?.source.requestId ===
        session.panel.conversationSource?.requestId
          ? 'draft'
          : 'chat'),
    );
  }
  function startIntent(
    requestId: string,
    text = '',
    manual = false,
    paragraphChoice = false,
    regenerate = false,
  ) {
    setAllowNewDraft(false);
    setIntent({ requestId, text, manual, paragraphChoice, regenerate });
  }
  async function confirmIntent() {
    if (!intent) return;
    const current = intent;
    setIntent(undefined);
    rememberScroll();
    await execute(() =>
      current.regenerate
        ? regenerateAI(current.requestId, mode)
        : current.manual
          ? createManualCardDraft(current.requestId)
          : generateCardDraft(
              current.requestId,
              current.text || undefined,
              mode === 'demo' ? demoResponder : undefined,
            ),
    );
  }
  function captureFragment(requestId: string, element: HTMLElement) {
    const selection = window.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      !element.contains(selection.anchorNode) ||
      !element.contains(selection.focusNode)
    )
      return;
    const text = selection.toString().trim();
    if (text) setSelectedFragment({ requestId, text });
  }
  if (view === 'source' && session.panel.conversationSource)
    return (
      <div className="reading-ai">
        <ConversationSource
          source={session.panel.conversationSource}
          onBack={returnSource}
        />
      </div>
    );
  if (!research || !conversation)
    return (
      <div className="reading-ai">
        <div className="ai-empty">
          <Sparkles size={30} />
          <h3>围绕研究提问</h3>
          <p>
            请先打开一个研究，再把阅读选区加入对话。全局资料不会自动继承其他研究的材料。
          </p>
        </div>
      </div>
    );
  if (view === 'history')
    return (
      <div className="reading-ai">
        <ConversationHistory state={historyStates[research.id] ?? initialHistoryState} onState={value => setHistoryStates(previous => ({ ...previous, [research.id]: value }))} onBack={() => updatePanel('chat')} />
      </div>
    );
  if (view === 'draft' && session.panel.aiDraftId)
    return (
      <div className="reading-ai">
        <CardDraftEditor
          key={session.panel.aiDraftId}
          draftId={session.panel.aiDraftId}
          demo={mode === 'demo'}
          onBack={() => updatePanel('chat')}
          onSource={(source) => showSource(source, 'draft')}
        />
      </div>
    );
  if (conversation.boardResearch?.view === 'literature') return <div className="reading-ai"><BoardLiterature key={conversation.id} conversationId={conversation.id} /></div>;
  const pendingRequest = intent && data.requests[intent.requestId];
  const paragraphs =
    pendingRequest?.body
      .split(/\n\s*\n/)
      .filter((paragraph) => paragraph.trim()) ?? [];
  const regenerationHistory = intent?.regenerate && connectionId !== 'codex'
    ? historyForConversation(data, conversation.id, intent.requestId)
    : [];
  let regenerationContext: ContextSnapshot[] = [],
    regenerationError = '';
  if (intent?.regenerate) {
    try {
      regenerationContext = snapshotContext(
        data,
        research.id,
        conversation.id,
        regenerationHistory,
      );
    } catch (caught) {
      regenerationError =
        caught instanceof Error ? caught.message : '当前材料无法发送';
    }
    if (pendingRequest?.boardContext && pendingRequest.boardContext.intent !== 'create' && conversation.boardSkill?.boardId !== pendingRequest.boardContext.boardId)
      regenerationError = '请先关闭此窗口，在“修改已有白板”中重新选择原目标。每次修改只作用于明确选中的白板。';
  }
  // Save before native cursor listeners can flush other workspace updates.
  const updateComposerInput = (value: string) => {
    const current = actions.getState().data.conversations[conversation.id];
    if (!current || current.input === value) return;
    actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].input = value; });
  };
  const composerInput = (<textarea
          ref={input}
          rows={1}
          aria-label="向 AI 提问"
          title="⌘ / Ctrl + Enter 发送"
          placeholder="基于这些材料提问，或继续追问…"
          value={prompt}
          onInputCapture={event => updateComposerInput(event.currentTarget.value)}
          onChange={event => updateComposerInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229
            ) {
              event.preventDefault();
              if (canSend) void send();
            }
          }}
        />);
  const connectionStatus = mode === 'demo' ? '演示模式 · 预设回答，无真实模型调用'
    : native ? loadingAgents ? `正在检查 ${connectionLabel(connectionId)}…` : `${connectionLabel(connectionId)} · ${agent ? agentStateLabel[agent.state] : '未连接'}${agent?.version ? ` · ${agent.version}` : ''}`
    : loadingConfig ? '正在检查模型配置…' : config?.configured ? `${config.model} · 真实模型` : '真实模型尚未连接';
  const composerLeading = <ComposerMaterials key={conversation.id} researchId={research.id} conversationId={conversation.id} disabled={!!generating} />;
  const composerTrailing = <><VoiceInput key={conversation.id} inputRef={input} />{generating ? (<>
    {generating.nativeRun?.managed && <button type="button" className="text-button" disabled={!canSteer} onClick={() => {
      setSteeringBusy(true); void execute(() => steerNativeRun(generating.id, prompt)).finally(() => setSteeringBusy(false));
    }}>{steeringBusy ? '正在补充…' : '补充本轮'}</button>}
    <button type="button" className="ai-composer-stop" aria-label="停止生成" title="停止当前生成" disabled={generating.nativeRun?.state === 'stopping'} onClick={() => stopAI(generating.id)}><Square size={13} fill="currentColor" /></button></>
  ) : <button type="button" className="primary ai-send" aria-label="发送问题" disabled={!canSend} onClick={() => void send()}><ArrowUp size={17} /></button>}</>;
  return (
    <section className="reading-ai ai-desktop-chat" aria-label="AI 阅读对话">
      <div className="ai-subhead ai-chat-head">
        <div className="ai-chat-title">
          <MessageSquare size={16} />
          <h3 title={conversation.title}>
            {conversation.title || '新的阅读对话'}
          </h3>
        </div>
        <div className={`ai-model-bar ${mode === 'demo' ? 'is-demo' : native ? agent?.state === 'ready' ? 'is-ready' : 'is-unavailable' : config?.configured ? 'is-ready' : 'is-unavailable'}`} title={connectionStatus}>
          <span className="ai-connection-indicator" role="status"><span className="sr-only">{connectionStatus}</span></span>
          <AgentPicker current={connectionId} agents={agents} loading={loadingAgents} error={agentError} model={config?.model} configured={!!config?.configured && !configError} onSelect={switchAgent} onRefresh={() => { void loadAgents(); void loadConfig(); }} />
        </div>
        {native && conversation.nativeSessionRef && !conversation.boardResearch && <button className="icon-button ai-head-action" aria-label="刷新记录" title={conversation.nativeImported ? '刷新原生记录 · 包含原有对话上下文' : '刷新项目内原生会话'} disabled={refreshingNative || !!generating} onClick={() => void refreshNative()}><RefreshCw size={14} /></button>}
        <button
          className="text-button ai-head-action"
          aria-label="查看会话历史"
          title="会话历史"
          onClick={() => {
            rememberScroll();
            updatePanel('history');
          }}
        >
          <History size={17} />
        </button>
        <button
          className="text-button ai-head-action"
          aria-label="新建干净对话"
          title={`继续使用${connectionLabel(connectionId)}，不带旧材料与历史`}
          onClick={() => {
            rememberScroll();
            actions.createConversation(research.id);
            input.current?.focus();
          }}
        >
          <Plus size={18} />
        </button>
      </div>
      {conversation.boardResearch && <BoardResearchHeading conversation={conversation} />}
      {!!backgroundTasks.length && <button className="ai-background-tasks" onClick={() => { rememberScroll(); updatePanel('history'); }}><span />{backgroundTasks.length} 个任务在其他对话运行 · 查看</button>}
      {native && !loadingAgents && (agentError || agent?.state !== 'ready') && <div className="ai-connection" role="status">
        <div className="ai-connection-header"><strong>{agent ? `${connectionLabel(connectionId)} · ${agentStateLabel[agent.state]}` : '本机助手未连接'}</strong><button className="text-button" onClick={() => void loadAgents()}><RefreshCw size={13} />重新连接助手</button></div>
        <details><summary>连接说明 · 当前输入和对话已保留</summary>
        <p>{agentError || agent?.detail || '请检查该助手的安装和登录状态，然后重新连接。'}</p>
        {agent?.state === 'not-installed' && agent.installation && <div className="ai-installation">
          <p>这里需要 {connectionLabel(connectionId)} 的本机运行时连接组件；安装桌面应用与配置此连接是两件事。</p>
          <a className="button ai-install-link" href={agent.installation.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />{agent.installation.label || '打开官方安装说明'}</a>
          {agent.installation.command && <div className="ai-install-command"><code>{agent.installation.command}</code><button className="text-button" onClick={() => void execute(async () => { await navigator.clipboard.writeText(agent.installation!.command!); actions.notice('安装命令已复制'); })}><Copy size={12} />复制安装命令</button></div>}
        </div>}
        </details>
      </div>}
      {!native && mode === 'live' &&
        (configError || (!loadingConfig && !config?.configured)) && (
          <div className="ai-connection">
            <div className="ai-connection-header"><strong>{configError ? '模型连接异常' : '真实模型尚未连接'}</strong><button className="text-button" disabled={loadingConfig} onClick={() => void loadConfig()}><RefreshCw size={13} />重新连接</button></div>
            <details>
              <summary>连接说明 · 当前输入和对话已保留</summary>
            <p>
              {configError ||
                (window.papertrailDesktop ? '请配置模型连接。API 密钥经系统加密保存在此电脑。' : '请在本地服务环境配置模型连接，然后重连。API 密钥仅保留在本地服务端。')}
            </p>
              <p>
                {window.papertrailDesktop ? '通过“配置模型连接”填写自己的 API 地址、模型和密钥；保存后连接自动更新。' : '启动 README 中的开发服务，设置本地 AI_API_KEY、AI_BASE_URL 和 AI_MODEL；修改配置后重启服务。界面不会读取或保存密钥。'}
              </p>
            {window.papertrailDesktop && <button className="text-button" onClick={() => void window.papertrailDesktop?.openAISettings()}>配置模型连接</button>}
            </details>
          </div>
        )}
      {!!openDrafts.length && (
        <div className="ai-pending-drafts">
          未确认草稿 · {openDrafts.length}
          {openDrafts.map((draft) => (
            <button
              key={draft.id}
              className="text-button"
              onClick={() => {
                rememberScroll();
                updatePanel('draft', draft.id);
              }}
            >
              {draft.title ||
                (draft.status === 'generating' ? '正在整理…' : '继续编辑')}{' '}
              →
            </button>
          ))}
        </div>
      )}

      <div className="ai-chat-messages">
      <div
        className="ai-chat-log"
        role="log"
        aria-live="off"
        aria-label="对话消息"
        data-conversation-id={conversation.id}
        tabIndex={0}
        ref={scroll}
        onScroll={() => {
          if (!scroll.current) return;
          const element = scroll.current,
            id = conversation.id,
            top = element.scrollTop;
          atBottom.current =
            element.scrollHeight - element.clientHeight - top < 90;
          if (atBottom.current) setHasNewContent(false);
          clearTimeout(scrollTimer.current);
          scrollTimer.current = setTimeout(
            () =>
              actions.updateData((next) => {
                if (next.conversations[id])
                  next.conversations[id].scrollTop = top;
              }),
            250,
          );
        }}
      >
        {conversation.nativeHistoryCursor && <button className="text-button" disabled={loadingOlder} onClick={() => {
          if (!scroll.current) return;
          const element = scroll.current, top = element.scrollTop, height = element.scrollHeight, id = conversation.id;
          setLoadingOlder(true); setOlderError('');
          void loadOlderProjectConversation(research.id, id).then(() => requestAnimationFrame(() => {
            if (element.dataset.conversationId === id) element.scrollTop = element.scrollHeight - height + top;
          })).catch(caught => setOlderError(caught instanceof Error ? caught.message : '较早记录读取失败，请重试。')).finally(() => setLoadingOlder(false));
        }}>{loadingOlder ? '正在读取…' : '加载更早对话'}</button>}
        {olderError && <p className="ai-error" role="status">{olderError}</p>}
        {!requests.length && (
          <div className="ai-welcome-new">
            <h3>新对话</h3>
            <p>
              输入问题，或选择原文后加入材料。
            </p>
            <p className="board-capability-example">也可以直接说：“把这些观点画成关系图”。生成的白板会留在聊天中，随时打开或撤销。</p>
          </div>
        )}
        {requests.map((request, index) => {
          if (request.researchRun && data.agentWorkbench !== false) return <ResearchAgentTurn key={request.id} researchId={research.id} request={request} index={index} busy={requests.some(item => item.status === 'generating')}/>;
          const incomplete = request.status !== 'done';
          const blocked = incomplete || !!request.validationError || !!request.nativeImported;
          return (
            <article
              className="ai-turn"
              key={request.id}
              data-request-id={request.id}
            >
              <div className="ai-user-message" aria-label="你的问题">{request.prompt}</div>
              {request.legacy && <p className="ai-scope-notice">旧版保存记录：回答可能曾被编辑，无法保证是原始模型输出；不纳入前序对话。</p>}
              <details className="ai-turn-range">
                <summary>
                  {request.nativeImported ? '来自原生记录 · 原有材料未关联' : <>{request.connectionId && request.connectionId !== 'model' && request.connectionId !== 'demo' ? `${connectionLabel(request.connectionId)} · ` : ''}发送时：{request.context.length + (request.materials?.length ?? 0)} 条材料 ·{' '}{request.history?.length ?? 0} 轮前序对话</>}
                </summary>
                {request.nativeImported && <p>保留原始对话文本；附件、引用及压缩前的历史不一定包含在此记录中。原生会话可能仍使用此前上下文。</p>}
                {request.connectionId === 'codex' && <div className="codex-request-settings"><span>{request.codex?.mode === 'plan' ? 'Plan' : 'Chat'} · {request.codex?.model || request.model || '连接默认模型'}{request.codex?.effort ? ` · ${request.codex.effort}` : ''}</span><span>权限：{request.codex?.access === 'full-access' ? '完全访问' : request.codex?.access === 'workspace-write' ? '项目内写入' : '只读'}</span>{!!request.skills?.length && <span>技能：{request.skills.map(skill => skill.name).join('、')}</span>}</div>}
                <ContextDetails items={request.context} />
                <ResearchRequestDetails request={request} />
                {request.history?.map((turn, index) => (
                  <details className="ai-details" key={turn.requestId}>
                    <summary>
                      前序问答 {index + 1}：{turn.prompt}
                    </summary>
                    <MarkdownContent text={turn.sentBody ?? turn.body} />
                    <ResearchMaterialDetails items={turn.materials ?? []} />
                    <ContextDetails
                      items={
                        turn.sentBody === undefined
                          ? originalAnswerContext(turn)
                          : request.context
                      }
                    />
                  </details>
                ))}
              </details>
              <div className="ai-answer-heading">
                <Sparkles size={14} />
                <strong>
                  {request.mode === 'demo'
                    ? 'AI 演示'
                    : (request.connectionId && !['model', 'demo'].includes(request.connectionId) ? connectionLabel(request.connectionId) : request.model ?? 'AI 助手')}

                </strong>
                {request.model && request.connectionId && !['model', 'demo'].includes(request.connectionId) && <small className="ai-answer-model">{request.model}</small>}
                {request.superseded && (
                  <span className="ai-badge">保留的旧版本</span>
                )}
              </div>
              {request.boardContext && <p className="ai-footnote">{request.boardContext.intent === 'create' ? '新建白板 · 提交时的对话与本轮材料' : `修改白板 · ${request.boardContext.snapshot.board.title} · 提交时版本 ${request.boardContext.revision}`} · {request.boardContext.resources.length} 项资料快照</p>}
              {!request.nativeRun && !!request.events?.length && <AgentActivity events={request.events} generating={request.status === 'generating'} />}
              {!request.nativeRun && request.interactions?.map(interaction => <AgentInteractionCard key={interaction.id} request={request} interaction={interaction} />)}
              <div
                className="ai-answer"
                tabIndex={0}
                onMouseUp={(event) =>
                  captureFragment(request.id, event.currentTarget)
                }
                onKeyUp={(event) =>
                  captureFragment(request.id, event.currentTarget)
                }
              >
                {request.nativeRun && !(request.status === 'done' && request.boardProposal) ? <NativeRunTimeline request={request} /> : <MarkdownContent text={request.status === 'done' && request.boardProposal ? request.boardProposal.summary : request.body} />}
                {request.nativeRun && request.status === 'done' && request.boardProposal && <details className="ai-details"><summary>助手执行记录</summary><NativeRunTimeline request={request} /></details>}
              </div>
              {request.status !== 'generating' && <SourceRecommendations request={request}/>}
              {request.status === 'done' && request.boardProposal && <BoardProposal request={request} />}
              {request.id === suggestionRequestId && request.status === 'done' && !request.boardContext && <div className="board-chat-suggestion" aria-label="白板建议"><p>这些观点和关系可以放在一张白板上对照。</p><div><button className="text-button" disabled={!canUseAgent} onClick={() => void createSuggestedBoard(request)}><Network size={13} />生成关系图</button><button className="text-button" onClick={() => actions.updateData(next => { next.conversations[conversation.id].boardSuggestionDismissed = true; })}>暂不需要</button></div></div>}
              {request.status === 'generating' && !request.nativeRun && (
                <div className="ai-generating" role="status">
                  <span />
                  {request.nativeImported ? '原生回合正在运行，正在同步记录…' : request.interactions?.some(interaction => interaction.status === 'pending') ? '等待你的答复…' : request.events?.at(-1)?.status === 'running' ? request.events.at(-1)?.text : '正在生成回答…'}
                </div>
              )}

              {request.status !== 'generating' && incomplete && (
                <div className={request.status === 'error' ? 'ai-error' : 'ai-scope-notice'} role={request.status === 'error' ? 'alert' : 'status'}>
                  {request.error ||
                    (request.nativeRun ? '本轮未完成，原生会话仍保留已发送内容。' : '回答未完成，已保留收到的内容。此轮不会进入后续默认历史。')}
                  {!request.nativeImported && <button
                    className="text-button"
                    onClick={() =>
                      void execute(() => retryAI(request.id, mode))
                    }
                  >
                    {request.nativeRun ? '在此对话中重试' : '按原范围重试'}
                  </button>}
                </div>
              )}
              {request.validationError && (
                <div className="ai-error" role="alert">
                  {request.boardContext ? <>
                    白板方案暂未解析：{request.validationError}
                    {request.status === 'done' && <button className="text-button" onClick={() => void execute(() => reparseBoardProposal(request.id))}>重新解析白板</button>}
                  </> : <>
                    引用检查未通过：{request.validationError}
                    。可修复来源后重试，或整理为仅对话来源的人工草稿。
                  </>}
                </div>
              )}
              {!!request.evidenceIds.length && (
                <div className="ai-citations">
                  {request.evidenceIds.map((id, index) => {
                    const evidence = data.evidence[id];
                    const snapshot = request.context.find(
                      (item) => item.evidenceId === id,
                    );
                    const available = hasOriginalDocument(data, snapshot);
                    return (
                      <button
                        key={id}
                        className="ai-citation"
                        disabled={!available}
                        title={
                          available
                            ? '在中央阅读器查看原文，保留 AI 回答'
                            : '原文件缺失或版本变化，摘录仍保留在发送范围中'
                        }
                        aria-label={`引用 ${index + 1}：${snapshot?.title ?? '来源缺失'} PDF 第 ${(snapshot?.pageIndex ?? 0) + 1} 页`}
                        onClick={() =>
                          snapshot &&
                          available &&
                          void execute(() =>
                            actions.openResource(
                              { kind: 'document', id: snapshot.documentId },
                              {
                                scope: data.scope,
                                target: 'main',
                                anchor: {
                                  evidenceId:
                                    evidence?.documentId ===
                                      snapshot.documentId &&
                                    evidence.pageIndex === snapshot.pageIndex &&
                                    evidence.quote === snapshot.quote
                                      ? id
                                      : undefined,
                                  pageIndex: snapshot.pageIndex,
                                },
                              },
                            ),
                          )
                        }
                      >
                        [{index + 1}] PDF 第 {(snapshot?.pageIndex ?? 0) + 1} 页
                        ↗
                      </button>
                    );
                  })}
                  {request.evidenceIds.some(
                    (id) =>
                      !hasOriginalDocument(
                        data,
                        request.context.find((item) => item.evidenceId === id),
                      ),
                  ) && (
                    <p className="ai-info">
                      原文件缺失或版本已变化，暂不回查当前文件；当时摘录和页码仍保留在发送范围中。
                    </p>
                  )}
                </div>
              )}
              {request.status !== 'generating' && (
                <div className="ai-message-actions">
                  <button
                    className="text-button"
                    disabled={!request.body}
                    onClick={() =>
                      void execute(async () => {
                        await navigator.clipboard.writeText(request.body);
                        actions.notice('回答已复制');
                      })
                    }
                  >
                    <Copy size={13} />
                    复制
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      showSource(
                        toSource(request, conversation.title ?? '阅读对话'),
                        'chat',
                      )
                    }
                  >
                    详情
                  </button>
                  {latest?.id === request.id &&
                    request.status === 'done' &&
                    !request.nativeImported &&
                    !generating && (
                      <button
                        className="text-button"
                        onClick={() => request.boardContext?.intent === 'create'
                          ? void execute(() => regenerateAI(request.id, mode))
                          : startIntent(request.id, '', false, false, true)}
                      >
                        <RefreshCw size={13} />
                        {request.boardContext?.intent === 'create' ? '再生成一张白板' : request.nativeRun ? '再回答一次' : '重新生成'}
                      </button>
                    )}
                  {!!request.body &&
                    (blocked ? (
                      <button
                        className="text-button"
                        onClick={() => startIntent(request.id, '', true)}
                      >
                        转为人工草稿
                      </button>
                    ) : (
                      <>
                        <button
                          className="text-button ai-card-action"
                          onClick={() => startIntent(request.id)}
                        >
                          <FilePlus2 size={14} />
                          整理为卡片
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            startIntent(request.id, '', false, true)
                          }
                        >
                          按段选择
                        </button>
                      </>
                    ))}
                  {research && conversation && request.status === 'done' && data.agentWorkbench !== false && discussionAnchor(conversation) && <CarryToConversation researchId={research.id} requestId={request.id} conversationId={conversation.id} />}
                </div>
              )}
              {!blocked && selectedFragment?.requestId === request.id && (
                <button
                  className="button ai-fragment-action"
                  onClick={() => startIntent(request.id, selectedFragment.text)}
                >
                  <FilePlus2 size={14} />
                  整理所选片段 · {selectedFragment.text.length} 字
                </button>
              )}
              {request.status === 'done' && !request.validationError && !request.nativeImported && (
                <details className="ai-extra-actions">
                  <summary>更多</summary>
                  <button
                    className="text-button"
                    onClick={() =>
                      void execute(() => {
                        const writing = Object.values(data.drafts).find(
                          (item) => item.researchId === research.id,
                        );
                        if (!writing) throw new Error('当前研究没有结论稿');
                        actions.updateData((next) =>
                          appendAIToDraft(next, writing.id, request),
                        );
                        actions.notice('已追加到结论，原有内容已保留');
                      })
                    }
                  >
                    追加到研究结论
                  </button>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {hasNewContent && (
        <button
          className="ai-new-content"
          onClick={() => {
            if (scroll.current)
              scroll.current.scrollTop = scroll.current.scrollHeight;
            atBottom.current = true;
            setHasNewContent(false);
          }}
        >
          <ArrowDown size={14} />
          有新内容
        </button>
      )}
      </div>
      <div className="sr-only" role="status">
        {latest?.status === 'generating'
          ? '正在回答'
          : latest?.status === 'done'
            ? '回答完成'
            : latest?.status === 'stopped'
              ? '生成已停止，内容已保留'
              : latest?.status === 'error'
                ? '生成失败，内容已保留'
                : ''}
      </div>
      <div className="ai-composer-new">
        {!!conversation.chatImages?.length && <ChatImagePreview images={conversation.chatImages} onRemove={id => removeChatImage(research.id, id)}/>}
        {conversation.drawingQuestion && <DrawingQuestionPreview question={conversation.drawingQuestion} onRemove={() => removeDrawingQuestion(research.id)}/>}
        {(conversation.chatImages?.length || conversation.drawingQuestion) ? <p className="ai-error" role="status">当前连接暂不能发送这些附件；可移除附件，或切回 Codex 研究助手。草稿已保留。</p> : null}
        {conversation.researchFocus && <div className="research-agent-focus"><span>围绕：{conversation.researchFocus.title}</span><button aria-label="清除追问对象" onClick={() => clearResearchFocus(research.id)}><X size={14}/></button></div>}
        <div className="ai-composer-options">
        {native && !directoryReady && <div className="ai-directory-needed" role="status"><strong>{research.directory ? refreshingNative ? '正在检查研究目录…' : '研究目录暂不可用' : '为这个研究选择目录'}</strong><ResearchDirectory researchId={research.id} label={research.directory ? '重新连接目录' : '选择研究目录'} />{directoryError && <p>{directoryError}</p>}</div>}
        {legacyNative && directoryReady && <div className="ai-scope-notice"><strong>旧版阅读对话</strong><p>此记录仍属于旧目录，可继续查看；在研究目录中开始新对话，原记录和输入会保留。</p><button className="text-button" onClick={() => { rememberScroll(); actions.createConversation(research.id); }}>在研究目录开始新对话</button></div>}
        {nativeBlocked && <div className="ai-scope-notice" role="status"><strong>{conversation.nativeState === 'busy' ? '正在原生应用中运行' : '当前可查看记录，暂不能继续发送'}</strong><p>{conversation.nativeReason || (conversation.nativeState === 'busy' ? '任务完成后可在这里继续。当前输入已保留。' : '尚不能确认此会话可以安全续接，请刷新记录。')}</p><button className="text-button" disabled={refreshingNative} onClick={() => void refreshNative()}>刷新会话状态</button></div>}
        {nativeRefreshError && directoryReady && <p className="ai-error" role="status">{nativeRefreshError}<button className="text-button" disabled={refreshingNative} onClick={() => void refreshNative()}>重新读取记录</button></p>}
        {generating?.nativeRun?.managed && <p className="ai-footnote">“补充本轮”只发送文字，使用本轮已提交的材料与设置；未发送的文字会保留为草稿。</p>}
        {conversation.boardResearch ? <BoardResearchControls key={`research-controls-${conversation.id}`} conversation={conversation} disabled={!!generating} /> : <><details
          className="ai-materials"
        >
          <summary title="展开核对本轮材料与原文"><span>本轮材料 · {conversation.contextIds.length}</span>{conversation.contextIds.length > 0 && <span className="ai-material-preview">{data.documents[data.evidence[conversation.contextIds[0]]?.documentId]?.title ?? '来源缺失'}</span>}</summary>
          <div className="ai-material-list">
            {conversation.contextIds.map((id, index) => {
              const evidence = data.evidence[id],
                doc = evidence && data.documents[evidence.documentId];
              return (
                <div className="ai-material" key={id}>
                  <details>
                    <summary>
                      [{index + 1}] {doc?.title ?? '来源缺失'} · PDF 第{' '}
                      {(evidence?.pageIndex ?? 0) + 1} 页
                      {evidence?.kind === 'region' ? ' · 区域' : ''}
                    </summary>
                    {evidence?.kind === 'region' && evidence.region && (
                      <RegionPreview assetId={evidence.region.assetId} />
                    )}
                    <blockquote>
                      {evidence?.quote ?? '证据已缺失，请移除并重新添加。'}
                    </blockquote>
                  </details>
                  <button
                    className="icon-button"
                    aria-label={`移除本轮材料 ${index + 1}`}
                    onClick={() => {
                      actions.updateData((next) => {
                        next.conversations[conversation.id].contextIds =
                          next.conversations[conversation.id].contextIds.filter(
                            (eid) => eid !== id,
                          );
                      });
                      setScopeNotice(
                        '已从本轮材料移除。前序消息仍可能包含这段内容；如需排除，请开启不含历史的新对话。',
                      );
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {!conversation.contextIds.length && (
              <p className="ai-footnote">
                从 PDF 选取原文，或在证据条目中点击“加入 AI”。
              </p>
            )}
          </div>
        </details>
        <details className="ai-context-settings">
          <summary title={native ? `Agent 累计已发 ${conversation.sentContext?.length ?? 0} 条材料，展开核对完整范围` : '展开核对发送的历史与材料'}>{connectionId === 'codex' ? '连续对话' : `对话范围 · ${selectedHistory.length} 轮`}</summary>
        {connectionId === 'codex' ? <div className="ai-history-range"><p>每轮继续同一个 Codex 会话，上下文由 Codex 管理。需要排除旧历史时，请新建干净对话。</p><button className="text-button" onClick={() => { rememberScroll(); actions.createConversation(research.id); }}>开启独立对话</button></div> : <div className="ai-history-range">
          <label htmlFor={`history-${conversation.id}`}>
            前序对话 · {selectedHistory.length} 轮
          </label>
          <select
            id={`history-${conversation.id}`}
            aria-label="前序对话范围"
            value={conversation.historyRange ?? 'all'}
            onChange={(event) =>
              actions.updateData((next) => {
                next.conversations[conversation.id].historyRange = event.target
                  .value as 'all' | 'latest' | 'none';
              })
            }
          >
            <option value="all">本会话全部</option>
            <option value="latest">最近 1 轮</option>
            <option value="none">不含前序对话</option>
          </select>
        </div>}
        {native && <details className="ai-native-scope">
          <summary>Agent 累计范围 · {conversation.sentContext?.length ?? 0} 条已发材料</summary>
          <p>原生会话可能保留此前发送的问答、材料和工具结果。移除本轮材料不会清除这些历史。</p>
          {conversation.nativeReason && <p>{conversation.nativeReason}</p>}
          {!!conversation.sentContext?.length && <ContextDetails items={conversation.sentContext} />}
          <p>{connectionId !== 'codex' && conversation.historyRange && conversation.historyRange !== 'all' ? '下次请求将从所选前序范围建立新的原生会话；旧会话记录仍保留。' : '如需完全独立的范围，请新建干净对话。'}</p>
        </details>}
        {!!selectedHistory.length && (
          <details className="ai-history-scope">
            <summary>{connectionId === 'codex' ? '查看本地保存的历史与来源' : '查看将发送的历史与旧材料'}</summary>
            {selectedHistory.map((turn, index) => (
              <details key={turn.requestId}>
                <summary>
                  第 {index + 1} 轮：{turn.prompt}
                </summary>
                <MarkdownContent text={turn.body} />
                <ContextDetails items={originalAnswerContext(turn)} />
                <p className="ai-footnote">
                  {connectionId === 'codex' ? '保留原始回答与来源；后续轮次不重复发送历史正文。' : '历史原答引用；提交时将按本次材料重编号。'}
                </p>
              </details>
            ))}
          </details>
        )}
        <p className="ai-scope-description">{conversation.boardSkill ? '本次修改所选白板；发送后恢复普通对话。' : native ? '本次提交所选材料和历史；Agent 还可能使用累计会话内容及已授权的目录、工具。' : '只发送显式材料及所选历史，不自动发送整篇论文。'}</p>
        </details></>}
        {scopeNotice && (
          <p className="ai-scope-notice" role="status">
            {scopeNotice}
          </p>
        )}
        {missingImages && (
          <p className="ai-error">
            当前助手或所选模型未确认支持区域图片。请切换支持图片的模型，或调整材料与历史范围；区域证据仍会保留。
          </p>
        )}
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        <ReportedChanges diff={latest?.events?.find(event => event.id === 'turn-diff' && event.toolName === 'fileChange')?.output} />
        <details key={conversation.id} className="ai-board-options" open={!!conversation.boardSkill || undefined}>
          <summary title="生成白板或选择本次修改的白板">{conversation.boardSkill ? `修改白板 · ${data.boards[conversation.boardSkill.boardId]?.title ?? '目标已缺失'}` : '白板工具'}</summary>
          <BoardSkillPanel conversation={conversation} disabled={!!generating} canCreate={canUseAgent} onCreate={() => void send('create')} />
        </details>
        </div>
        <div className="ai-input-shell">
          {connectionId === 'codex' ? (
            <CodexComposerTools key={conversation.id} ref={codexTools} inputRef={input} value={prompt} skills={conversation.skills ?? []} settings={conversation.codex ?? {}} status={agent ? agentStateLabel[agent.state] : '未连接'} onInput={value => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].input = value; })} onSkills={skills => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].skills = skills; })} onSettings={codex => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].codex = codex; })} onNew={() => { rememberScroll(); actions.createConversation(research.id); input.current?.focus(); }} disabled={!!generating} projectPath={research.directory?.path} onCapabilities={setCodexCatalog} leadingControls={composerLeading} trailingControls={composerTrailing}>
              {composerInput}
            </CodexComposerTools>
          ) : <>{composerInput}<div className="ai-composer-footer">{composerLeading}<div className="ai-composer-actions">{composerTrailing}</div></div></>}
        </div>
        <p className="ai-sending-note sr-only">
          ⌘ / Ctrl + Enter 发送 · {conversation.boardSkill ? '本次修改所选白板；发送后恢复普通对话。' : native ? '本次提交所选材料和历史；Agent 还可能使用累计会话内容。' : '只发送显式材料及所选历史，不自动发送整篇论文。'}
        </p>
      </div>
      <dialog
        ref={dialog}
        className="ai-intent-dialog"
        aria-labelledby="ai-intent-title"
        onCancel={() => setIntent(undefined)}
        onClose={() => {
          if (intent) setIntent(undefined);
        }}
      >
        {pendingRequest && (
          <>
            <div className="ai-dialog-heading">
              <h3 id="ai-intent-title">
                {intent?.regenerate
                  ? connectionId === 'codex' ? '在当前对话再回答一次' : '确认重新生成范围'
                  : intent?.paragraphChoice
                    ? '选择值得留下的知识点'
                    : intent?.manual
                      ? '整理为人工草稿'
                      : '确认卡片整理范围'}
              </h3>
              <button
                ref={closeIntent}
                className="icon-button"
                aria-label="取消整理"
                onClick={() => setIntent(undefined)}
              >
                <X size={17} />
              </button>
            </div>
            {!intent?.regenerate && !!openDrafts.length && !allowNewDraft ? (
              <div className="ai-existing-draft">
                <p>
                  此对话已有 {openDrafts.length}{' '}
                  份未确认草稿。可以继续编辑，也可以另建，已有内容会保留。
                </p>
                {openDrafts.map((draft) => (
                  <button
                    className="button"
                    key={draft.id}
                    onClick={() => {
                      setIntent(undefined);
                      rememberScroll();
                      updatePanel('draft', draft.id);
                    }}
                  >
                    继续：{draft.title || '未命名草稿'}
                  </button>
                ))}
                <button
                  className="text-button"
                  onClick={() => setAllowNewDraft(true)}
                >
                  保留已有草稿，另建一份
                </button>
              </div>
            ) : (
              <>
                {intent?.manual && (
                  <p className="ai-info">
                    未完成或引用异常的回答将转为人工草稿，移除正文中的 [n]
                    引用编号，仅保留对话来源并标记待核查。完整原始回答仍留在来源快照中。此动作不向模型发送内容。
                  </p>
                )}
                {intent?.regenerate ? (
                  <>
                    <p className="ai-info">
                      {connectionId === 'codex' ? '在同一个 Codex 会话中继续一轮。原始回答仍在原生上下文中，已有卡片来源会保留；需要独立范围时请新建对话。' : '使用当前材料和所选历史生成新版本，原始回答与已有卡片来源会保留。'}
                    </p>
                    <h4>再次提问</h4>
                    <p className="ai-dialog-question">
                      {pendingRequest.prompt}
                    </p>
                    <h4>
                      将发送 {regenerationContext.length} 条材料 ·{' '}
                      {regenerationHistory.length} 轮前序对话
                    </h4>
                    <ContextDetails items={regenerationContext} />
                    {regenerationHistory.map((turn) => (
                      <details key={turn.requestId}>
                        <summary>{turn.prompt}</summary>
                        <MarkdownContent text={turn.body} />
                        <ContextDetails items={originalAnswerContext(turn)} />
                        <p className="ai-footnote">
                          历史原答引用；提交时将按本次材料重编号。
                        </p>
                      </details>
                    ))}
                    {regenerationError && (
                      <p className="ai-error" role="alert">
                        {regenerationError}
                      </p>
                    )}
                  </>
                ) : intent?.paragraphChoice ? (
                  <fieldset className="ai-paragraphs">
                    <legend>选择一段回答，原始问答和上下文仍会保留</legend>
                    {paragraphs.map((paragraph, index) => (
                      <label key={index}>
                        <input
                          type="radio"
                          name="answer-paragraph"
                          value={paragraph}
                          checked={intent.text === paragraph}
                          onChange={() =>
                            setIntent({ ...intent, text: paragraph })
                          }
                        />
                        <span>{paragraph}</span>
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  <>
                    <h4>原始问题</h4>
                    <p className="ai-dialog-question">
                      {pendingRequest.prompt}
                    </p>
                    <h4>{intent?.text ? '仅整理所选片段' : '整理整条回答'}</h4>
                    <div className="ai-intent-answer">
                      {intent?.text ? (
                        <p className="ai-prewrap">{intent.text}</p>
                      ) : (
                        <MarkdownContent text={pendingRequest.body} />
                      )}
                    </div>
                  </>
                )}
                {!intent?.regenerate && (
                  <details className="ai-details">
                    <summary>
                      关联材料 · {pendingRequest.context.length} 条，以及本次{' '}
                      {pendingRequest.history?.length ?? 0} 轮历史
                    </summary>
                    <ContextDetails items={pendingRequest.context} />
                  </details>
                )}
                <p className="ai-footnote">
                  {intent?.regenerate
                    ? `${mode === 'demo' ? '使用演示预设' : `发送到${connectionLabel(connectionId)}`}。前序材料可能仍存在于历史中；可取消并调整范围。`
                    : intent?.manual
                      ? '保留原始问答，草稿由你编辑后确认加入卡片。'
                      : `${mode === 'demo' ? '使用演示预设' : `使用${connectionLabel(connectionId)}`}整理；会发送原始问答、所选片段及该轮材料。结果先进入独立草稿，由你修改确认。`}
                </p>
                <div className="ai-dialog-actions">
                  <button
                    className="button"
                    onClick={() => setIntent(undefined)}
                  >
                    取消
                  </button>
                  <button
                    className="primary"
                    disabled={
                      !!regenerationError ||
                      (intent?.paragraphChoice && !intent.text)
                    }
                    onClick={() => void confirmIntent()}
                  >
                    <FilePlus2 size={14} />
                    {intent?.regenerate
                      ? '生成新版本'
                      : intent?.manual
                        ? '创建人工草稿'
                        : '生成卡片草稿'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </dialog>
    </section>
  );
}
