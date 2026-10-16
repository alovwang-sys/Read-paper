import { ArrowLeft, MessageSquare } from 'lucide-react';
import type { CardProvenance } from '../../domain/types';
import { useWorkspace } from '../../services/workspace';
import {
  ContextDetails,
  hasOriginalDocument,
  originalAnswerContext,
} from './SourceDetails';
import { MarkdownContent } from './MarkdownContent';

const requestStatus = {
  generating: '生成中',
  done: '已完成',
  error: '失败',
  stopped: '已停止',
  interrupted: '已中断',
};

export function ConversationSource({
  source,
  onBack,
}: {
  source: CardProvenance;
  onBack: () => void;
}) {
  const { data, actions } = useWorkspace();
  const request = data.requests[source.requestId];
  const conversation = data.conversations[source.conversationId];
  const sameResearch =
    source.researchId ===
    (data.scope.kind === 'research' ? data.scope.researchId : undefined);
  const selectedIndex = source.selection
    ? source.answer.indexOf(source.selection)
    : -1;
  const answerEvidenceIds =
    source.answerEvidenceIds ?? source.context.map((item) => item.evidenceId);
  return (
    <section className="ai-source-view">
      <div className="ai-subhead">
        <button
          className="icon-button"
          aria-label="返回来源入口"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <h3>相关对话</h3>
        <span className="ai-badge">创建时快照</span>
      </div>
      <div className="ai-content-scroll">
        <p className="ai-eyebrow">CONVERSATION SOURCE</p>
        <h3>当时，如何形成这个理解？</h3>
        <p className="ai-footnote">
          {data.researches[source.researchId]?.title ?? '原研究'} ·{' '}
          {source.conversationTitle || '阅读对话'}
          <br />
          {new Date(source.createdAt).toLocaleString('zh-CN')} ·{' '}
          {source.model ?? '旧记录未保存模型'}
        </p>
        {(source.incomplete || request?.legacy) && (
          <p className="ai-info">{request?.legacy ? '旧版保存记录可能曾被编辑，无法保证是原始模型输出。' : '此来源记录不完整，保留创建时的内容，请核查。'}</p>
        )}
        {!sameResearch && (
          <p className="ai-info">
            正在只读查阅其他研究的来源；主区任务保持原位。
          </p>
        )}
        <h4>原始问题</h4>
        <div className="ai-user-message">{source.prompt}</div>
        <h4>
          {request?.legacy ? '旧版保存的回答' : '原始回答'}{' '}
          {source.selection && <span className="ai-badge">已标记整理片段</span>}
        </h4>
        {selectedIndex >= 0 ? (
          <div className="ai-source-answer">
            <MarkdownContent text={source.answer.slice(0, selectedIndex)} />
            <mark className="ai-source-highlight">{source.selection}</mark>
            <MarkdownContent
              text={source.answer.slice(
                selectedIndex + source.selection.length,
              )}
            />
          </div>
        ) : (
          <>
            <MarkdownContent text={source.answer || '本次未收到回答。'} />
            {source.selection && (
              <details open>
                <summary>整理时选择的片段</summary>
                <mark className="ai-source-highlight">{source.selection}</mark>
              </details>
            )}
          </>
        )}
        {!!answerEvidenceIds.length && (
          <div className="ai-answer-sources">
          <h4>原回答的引用</h4>
            <div className="ai-citations">
              {answerEvidenceIds.map((id, index) => {
                const snapshot = source.context.find(
                  (item) => item.evidenceId === id,
                );
                const available = hasOriginalDocument(data, snapshot);
                const evidence = data.evidence[id];
                return (
                  <button
                    className="ai-citation"
                    key={id}
                    disabled={!available}
                    title={
                      available
                        ? '在主区核对原文，保留相关对话'
                        : '原文件缺失或版本变化，摘录仍保留在来源详情中'
                    }
                    onClick={() => {
                      if (!snapshot || !available) return;
                      try {
                        actions.openResource(
                          { kind: 'document', id: snapshot.documentId },
                          {
                            scope: data.scope,
                            target: 'main',
                            anchor: {
                              evidenceId:
                                evidence?.documentId === snapshot.documentId &&
                                evidence.pageIndex === snapshot.pageIndex &&
                                evidence.quote === snapshot.quote
                                  ? id
                                  : undefined,
                              pageIndex: snapshot.pageIndex,
                            },
                          },
                        );
                      } catch (caught) {
                        actions.notice(
                          caught instanceof Error
                            ? caught.message
                            : '原文暂不可用',
                        );
                      }
                    }}
                  >
                    [{index + 1}] {snapshot?.title ?? '来源缺失'} · PDF 第{' '}
                    {(snapshot?.pageIndex ?? 0) + 1} 页 ↗
                  </button>
                );
              })}
            </div>
            <p className="ai-footnote">
              编号对应这份原始回答的来源顺序；完整发送材料另列在下方。
            </p>
            {answerEvidenceIds.some(
              (id) =>
                !hasOriginalDocument(
                  data,
                  source.context.find((item) => item.evidenceId === id),
                ),
            ) && (
              <p className="ai-info">
                部分原文件缺失或版本已变化。已保留创建时的原始回答、摘录与页码，暂不打开当前其他版本。
              </p>
            )}
          </div>
        )}
        <details className="ai-details">
          <summary>
            本次材料与前序对话 · {source.context.length} 条直接材料 /{' '}
            {request?.history?.length ?? 0} 轮历史
          </summary>
          <ContextDetails items={source.context} />
          {request?.history?.map((turn, index) => (
            <div className="ai-context-entry" key={turn.requestId}>
              <strong>前序问答 {index + 1}</strong>
              <p>{turn.prompt}</p>
              <MarkdownContent text={turn.sentBody ?? turn.body} />
              <details>
                <summary>
                  {turn.sentBody === undefined
                    ? '原回答引用'
                    : '实际发送编号对应的材料'}
                </summary>
                <ContextDetails
                  items={
                    turn.sentBody === undefined
                      ? originalAnswerContext(turn)
                      : source.context
                  }
                />
              </details>
            </div>
          ))}
        </details>
        {request && (
          <details className="ai-details">
            <summary>原请求信息</summary>
            <dl className="ai-meta">
              <dt>请求</dt>
              <dd>{request.id}</dd>
              <dt>模式</dt>
              <dd>
                {request.mode === 'live'
                  ? '真实模型'
                  : request.mode === 'demo'
                    ? '演示模式'
                    : '旧记录'}
              </dd>
              <dt>状态</dt>
              <dd>
                {requestStatus[request.status]}
                {request.superseded ? ' · 已有后续版本，此快照保持原样' : ''}
              </dd>
              <dt>模型</dt>
              <dd>{request.model ?? '未记录'}</dd>
            </dl>
          </details>
        )}
        {!!source.generationRequestIds.length && (
          <details className="ai-details">
            <summary>
              卡片整理与修订记录 · {source.generationRequestIds.length}
            </summary>
            {source.generationRequestIds.map((id) => {
              const generation = data.requests[id];
              return generation ? (
                <article className="ai-generation-record" key={id}>
                  <strong>
                    {generation.purpose === 'revision' ? 'AI 修订' : '整理卡片'}{' '}
                    · {new Date(generation.createdAt).toLocaleString('zh-CN')}
                  </strong>
                  <p className="ai-footnote">
                    {generation.model ?? '未记录模型'} ·{' '}
                    {generation.mode === 'demo'
                      ? '演示'
                      : generation.mode === 'live'
                        ? '真实模型'
                        : '未记录模式'}{' '}
                    · {requestStatus[generation.status]}
                  </p>
                  {generation.error && (
                    <p className="ai-error">{generation.error}</p>
                  )}
                  <details>
                    <summary>当次要求与回答</summary>
                    <p className="ai-prewrap">{generation.prompt}</p>
                    <MarkdownContent text={generation.body} />
                  </details>
                </article>
              ) : (
                <p className="ai-footnote" key={id}>
                  生成记录暂不可用：{id}
                </p>
              );
            })}
          </details>
        )}
        <p className="ai-footnote">
          卡片编辑不会改写这份问答快照。论文用于核对事实，对话用于回顾解释。
        </p>
        {conversation && data.researches[source.researchId] && (
          <button
            className="button ai-full-width"
            onClick={() => {
              if (!sameResearch) actions.switchResearch(source.researchId);
              if (conversation.archived)
                actions.archiveConversation(conversation.id, false);
              actions.selectConversation(
                source.researchId,
                source.conversationId,
              );
              actions.updateData((next) => {
                next.sessions[source.researchId].panel.aiView = 'chat';
              });
              actions.setPanel('ai');
            }}
          >
            <MessageSquare size={14} />
            {!sameResearch
              ? '去原研究继续讨论'
              : conversation.archived
                ? '恢复并继续此对话'
                : '继续此对话'}
          </button>
        )}
      </div>
      <div className="ai-panel-footer">
        <small>只读来源快照</small>
        <button className="button" onClick={onBack}>
          返回
        </button>
      </div>
    </section>
  );
}
