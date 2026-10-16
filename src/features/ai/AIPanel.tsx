import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePlus2,
  ExternalLink,
  History,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import type {
  AgentConnection,
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
  regenerateAI,
  retryAI,
  snapshotContext,
  stopAI,
  submitAI,
} from '../../services/ai';
import { getActiveConversation, useWorkspace } from '../../services/workspace';
import { connectionLabel, conversationConnection, getAgents, selectAgent } from '../../services/agents';
import { CardDraftEditor } from '../cards/CardDraftEditor';
import { MarkdownContent } from './MarkdownContent';
import { ConversationHistory } from './ConversationHistory';
import { ConversationSource } from './ConversationSource';
import { AgentPicker, agentStateLabel } from './AgentPicker';
import { AgentActivity } from './AgentActivity';
import { CodexComposerTools, type CodexComposerToolsHandle } from './CodexComposerTools';
import { AgentInteractionCard } from './AgentInteractionCard';
import {
  ContextDetails,
  RegionPreview,
  hasOriginalDocument,
  originalAnswerContext,
} from './SourceDetails';
import './ai.css';

function toSource(request: AIRequest, title: string): CardProvenance {
  return {
    researchId: request.researchId,
    conversationId: request.conversationId,
    conversationTitle: title,
    requestId: request.id,
    prompt: request.prompt,
    answer: request.body,
    answerEvidenceIds: [...request.evidenceIds],
    selection: '',
    context: request.context,
    createdAt: request.createdAt,
    model: request.model,
    connectionId: request.connectionId,
    generationRequestIds: [],
    incomplete: request.status !== 'done' || !!request.legacy,
  };
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
    (request) => request.status === 'generating',
  );
  const selectedHistory = conversation
    ? historyForConversation(data, conversation.id)
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
    ) || selectedHistory.some(turn => turn.context.some(item => item.kind === 'region'))) &&
    !(native ? agent?.capabilities.images : config?.images);
  const canSend =
    !!prompt.trim() &&
    !generating &&
    (mode === 'demo' || (native ? agent?.state === 'ready' && !loadingAgents && !agentError : !!config?.configured && !configError)) &&
    !missingImages;
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
      setConfigError('无法连接本地 AI 服务。请启动服务后重连。');
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
  }, []);
  useEffect(() => {
    setError('');
    setScopeNotice('');
    setSelectedFragment(undefined);
    setIntent(undefined);
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
  }, [latest?.body, latest?.id, latest?.status, latest?.interactions?.length, view]);
  useLayoutEffect(() => {
    const element = input.current;
    if (view !== 'chat' || !element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(160, Math.max(76, element.scrollHeight))}px`;
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
  async function send() {
    if (connectionId === 'codex' && codexTools.current?.handleSubmit()) return;
    if (!research || !conversation || !canSend) return;
    atBottom.current = true;
    await execute(() =>
      submitAI(
        research.id,
        conversation.id,
        prompt,
        mode === 'demo' ? demoResponder : undefined,
      ),
    );
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
        <ConversationHistory onBack={() => updatePanel('chat')} />
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
  const pendingRequest = intent && data.requests[intent.requestId];
  const paragraphs =
    pendingRequest?.body
      .split(/\n\s*\n/)
      .filter((paragraph) => paragraph.trim()) ?? [];
  const regenerationHistory = intent?.regenerate
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
  }
  return (
    <section className="reading-ai ai-desktop-chat" aria-label="AI 阅读对话">
      <div className="ai-subhead ai-chat-head">
        <div className="ai-chat-title">
          <MessageSquare size={16} />
          <h3 title={conversation.title}>
            {conversation.title || '新的阅读对话'}
          </h3>
        </div>
        <button
          className="icon-button"
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
          className="icon-button"
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
      <div className={`ai-model-bar ${mode === 'demo' ? 'is-demo' : ''}`}>
        <Sparkles size={13} />
        <span>
          {mode === 'demo'
            ? '演示模式 · 预设回答，无真实模型调用'
            : native
              ? loadingAgents
                ? `正在检查 ${connectionLabel(connectionId)}…`
                : `${connectionLabel(connectionId)} · ${agent ? agentStateLabel[agent.state] : '未连接'}${agent?.version ? ` · ${agent.version}` : ''}`
            : loadingConfig
              ? '正在检查模型配置…'
              : config?.configured
                ? `${config.model} · 真实模型`
                : '真实模型尚未连接'}
        </span>
        {native && agent?.state === 'ready' && <span className="ai-badge">{connectionId === 'codex' ? '默认只读 · 逐次审批' : agent.capabilities.tools ? '只读工具' : '仅对话'}</span>}
      </div>
      {!!backgroundTasks.length && <button className="ai-background-tasks" onClick={() => { rememberScroll(); updatePanel('history'); }}><span />{backgroundTasks.length} 个任务在其他对话运行 · 查看</button>}
      {native && !loadingAgents && (agentError || agent?.state !== 'ready') && <div className="ai-connection" role="status">
        <p><strong>{agent ? `${connectionLabel(connectionId)} · ${agentStateLabel[agent.state]}` : '本机助手未连接'}</strong></p>
        <p>{agentError || agent?.detail || '请检查该助手的安装和登录状态，然后重新连接。'}</p>
        {agent?.state === 'not-installed' && agent.installation && <div className="ai-installation">
          <p>这里需要 {connectionLabel(connectionId)} 的本机运行时连接组件；安装桌面应用与配置此连接是两件事。</p>
          <a className="button ai-install-link" href={agent.installation.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />{agent.installation.label || '打开官方安装说明'}</a>
          {agent.installation.command && <div className="ai-install-command"><code>{agent.installation.command}</code><button className="text-button" onClick={() => void execute(async () => { await navigator.clipboard.writeText(agent.installation!.command!); actions.notice('安装命令已复制'); })}><Copy size={12} />复制安装命令</button></div>}
        </div>}
        <p>当前输入和对话已保留。</p>
        <button className="text-button" onClick={() => void loadAgents()}><RefreshCw size={13} />重新连接助手</button>
      </div>}
      {!native && mode === 'live' &&
        (configError || (!loadingConfig && !config?.configured)) && (
          <div className="ai-connection">
            <p>
              {configError ||
                '请在本地服务环境配置模型连接，然后重连。API 密钥仅保留在本地服务端。'}
            </p>
            <details>
              <summary>连接说明</summary>
              <p>
                启动 README 中的开发服务，设置本地 AI_API_KEY、AI_BASE_URL 和
                AI_MODEL；修改配置后重启服务。界面不会读取或保存密钥。
              </p>
            </details>
            <button
              className="text-button"
              disabled={loadingConfig}
              onClick={() => void loadConfig()}
            >
              <RefreshCw size={13} />
              重新连接
            </button>
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

      <div
        className="ai-chat-log"
        role="log"
        aria-live="off"
        aria-label="对话消息"
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
        {!requests.length && (
          <div className="ai-welcome-new">
            <div className="ai-welcome-icon">
              <Sparkles size={26} />
            </div>
            <h3>从证据出发，形成理解</h3>
            <p>
              选中论文中的文字，带着材料提问。
              <br />
              把值得留下的知识点，整理为卡片。
            </p>
            <small>原始问答和论文来源会一起保留。</small>
          </div>
        )}
        {requests.map((request) => {
          const incomplete = request.status !== 'done';
          const blocked = incomplete || !!request.validationError;
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
                  {request.connectionId && request.connectionId !== 'model' && request.connectionId !== 'demo' ? `${connectionLabel(request.connectionId)} · ` : ''}发送时：{request.context.length} 条材料 ·{' '}
                  {request.history?.length ?? 0} 轮前序对话
                </summary>
                {request.connectionId === 'codex' && <div className="codex-request-settings"><span>{request.codex?.mode === 'plan' ? 'Plan' : 'Chat'} · {request.codex?.model || request.model || '连接默认模型'}</span>{!!request.skills?.length && <span>技能：{request.skills.map(skill => skill.name).join('、')}</span>}</div>}
                <ContextDetails items={request.context} />
                {request.history?.map((turn, index) => (
                  <details className="ai-details" key={turn.requestId}>
                    <summary>
                      前序问答 {index + 1}：{turn.prompt}
                    </summary>
                    <MarkdownContent text={turn.sentBody ?? turn.body} />
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
              {!!request.events?.length && <AgentActivity events={request.events} generating={request.status === 'generating'} />}
              {request.interactions?.map(interaction => <AgentInteractionCard key={interaction.id} request={request} interaction={interaction} />)}
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
                <MarkdownContent text={request.body} />
              </div>
              {request.status === 'generating' && (
                <div className="ai-generating">
                  <span />
                  {request.interactions?.some(interaction => interaction.status === 'pending') ? '等待你的答复…' : request.events?.at(-1)?.status === 'running' ? request.events.at(-1)?.text : '正在生成回答…'}
                </div>
              )}

              {request.status !== 'generating' && incomplete && (
                <div className="ai-error" role="alert">
                  {request.error ||
                    '回答未完成，已保留收到的内容。此轮不会进入后续默认历史。'}
                  <button
                    className="text-button"
                    onClick={() =>
                      void execute(() => retryAI(request.id, mode))
                    }
                  >
                    按原范围重试
                  </button>
                </div>
              )}
              {request.validationError && (
                <p className="ai-error" role="alert">
                  引用检查未通过：{request.validationError}
                  。可修复来源后重试，或整理为仅对话来源的人工草稿。
                </p>
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
                    !generating && (
                      <button
                        className="text-button"
                        onClick={() =>
                          startIntent(request.id, '', false, false, true)
                        }
                      >
                        <RefreshCw size={13} />
                        重新生成
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
              {request.status === 'done' && !request.validationError && (
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
        <details
          className="ai-materials"
          open={conversation.contextIds.length > 0 || undefined}
        >
          <summary>本轮材料 · {conversation.contextIds.length}</summary>
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
          <summary>对话范围 · 前序 {selectedHistory.length} 轮{native ? ` · Agent 已发 ${conversation.sentContext?.length ?? 0} 条材料` : ''}</summary>
        <div className="ai-history-range">
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
        </div>
        {native && <details className="ai-native-scope">
          <summary>Agent 累计范围 · {conversation.sentContext?.length ?? 0} 条已发材料</summary>
          <p>原生会话可能保留此前发送的问答、材料和工具结果。移除本轮材料不会清除这些历史。</p>
          {!!conversation.sentContext?.length && <ContextDetails items={conversation.sentContext} />}
          <p>{conversation.historyRange && conversation.historyRange !== 'all' ? '下次请求将从所选前序范围建立新的原生会话；旧会话记录仍保留。' : '如需完全独立的范围，请新建干净对话。'}</p>
        </details>}
        {!!selectedHistory.length && (
          <details className="ai-history-scope">
            <summary>查看将发送的历史与旧材料</summary>
            {selectedHistory.map((turn, index) => (
              <details key={turn.requestId}>
                <summary>
                  第 {index + 1} 轮：{turn.prompt}
                </summary>
                <MarkdownContent text={turn.body} />
                <ContextDetails items={originalAnswerContext(turn)} />
                <p className="ai-footnote">
                  历史原答引用；提交时将按本次材料重编号。
                </p>
              </details>
            ))}
          </details>
        )}
        </details>
        {scopeNotice && (
          <p className="ai-scope-notice" role="status">
            {scopeNotice}
          </p>
        )}
        {missingImages && (
          <p className="ai-error">
            当前助手不支持区域图片。本轮材料或所选历史含图片，请调整材料与历史范围，或切换支持图片的助手；区域证据仍会保留。
          </p>
        )}
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        <div className="ai-input-shell">
        {connectionId === 'codex' && <CodexComposerTools key={conversation.id} ref={codexTools} inputRef={input} value={prompt} skills={conversation.skills ?? []} settings={conversation.codex ?? {}} status={agent ? agentStateLabel[agent.state] : '未连接'} onInput={value => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].input = value; })} onSkills={skills => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].skills = skills; })} onSettings={codex => actions.updateData(next => { if (next.conversations[conversation.id]) next.conversations[conversation.id].codex = codex; })} onNew={() => { rememberScroll(); actions.createConversation(research.id); input.current?.focus(); }} />}
        <textarea
          ref={input}
          aria-label="向 AI 提问"
          placeholder="基于这些材料提问，或继续追问…"
          value={prompt}
          onChange={(event) =>
            actions.updateData((next) => {
              next.conversations[conversation.id].input = event.target.value;
            })
          }
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
        />
        <div className="ai-composer-footer">
          <AgentPicker current={connectionId} agents={agents} loading={loadingAgents} error={agentError} model={config?.model} configured={!!config?.configured && !configError} onSelect={switchAgent} onRefresh={() => { void loadAgents(); void loadConfig(); }} />
          {generating ? (
            <button className="button" onClick={() => stopAI(generating.id)}>
              <Square size={13} />
              停止生成
            </button>
          ) : (
            <button
              className="primary ai-send"
              aria-label="发送问题"
              disabled={!canSend}
              onClick={() => void send()}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
        </div>
        <p className="ai-sending-note">
          ⌘ / Ctrl + Enter 发送 · {native ? '本次提交所选材料和历史；Agent 还可能使用累计会话内容。' : '只发送显式材料及所选历史，不自动发送整篇论文。'}
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
                  ? '确认重新生成范围'
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
                      使用当前材料和所选历史生成新版本，原始回答与已有卡片来源会保留。
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
