import { useState } from 'react';
import { ArrowUp, FilePlus2, Sparkles, X } from 'lucide-react';
import { appendAIToDraft, submitAI, validateResponse } from '../../services/ai';
import { useWorkspace } from '../../services/workspace';

export function AIPanel() {
  const { data, research, actions } = useWorkspace();
  const [error, setError] = useState('');
  if (!research)
    return (
      <div className="empty-state">
        <Sparkles />
        <h3>围绕研究提问</h3>
        <p>打开一个研究，然后显式添加证据。</p>
      </div>
    );
  const conversation = data.conversations[`conversation-${research.id}`];
  const prompt = conversation.input ?? '比较这些证据，哪些条件仍需核查？';
  const requests = conversation.requestIds.map((id) => data.requests[id]);
  const generating = requests.some(
    (request) => request.status === 'generating',
  );
  async function send(question = prompt) {
    setError('');
    try {
      await submitAI(research!.id, conversation.id, question);
    } catch (error) {
      setError(error instanceof Error ? error.message : '生成失败');
    }
  }
  return (
    <div className="ai-panel">
      <div className="ai-banner">
        <Sparkles size={15} />
        <span>演示模式 · 尚未连接真实模型</span>
      </div>
      <div className="ai-messages">
        {!requests.length && (
          <div className="ai-welcome">
            <div className="ai-orb">
              <Sparkles size={26} />
            </div>
            <h3>从证据出发，形成理解</h3>
            <p>选择原文摘录，让问题与来源始终相连。</p>
            <small>仅使用下方显式列出的上下文。</small>
          </div>
        )}
        {requests.map((request) => (
          <article className="ai-message" key={request.id}>
            <div className="ai-question">{request.prompt}</div>
            <small className="muted">
              提交时使用 {request.context.length} 条证据 · 固定快照
            </small>
            {request.status === 'generating' ? (
              <p role="status">正在生成演示草稿…</p>
            ) : request.status === 'error' ? (
              <div className="error-box" role="alert">
                {request.error}
                <button
                  className="button"
                  onClick={() => void send(request.prompt)}
                >
                  重试生成
                </button>
              </div>
            ) : request.body ? (
              <>
                <label className="field">
                  可编辑草稿
                  <textarea
                    aria-label="AI 草稿"
                    value={request.body}
                    onChange={(event) =>
                      actions.updateData((data) => {
                        data.requests[request.id].body = event.target.value;
                      })
                    }
                  />
                </label>
                <div className="citation-list">
                  {request.evidenceIds.map((id, index) => {
                    const e = data.evidence[id];
                    return (
                      <button
                        className="citation"
                        key={id}
                        onClick={() =>
                          e &&
                          actions.openResource(
                            { kind: 'document', id: e.documentId },
                            {
                              scope: data.scope,
                              target: 'inspector',
                              anchor: {
                                evidenceId: id,
                                pageIndex: e.pageIndex,
                              },
                            },
                          )
                        }
                      >
                        [{index + 1}] PDF 第 {e?.pageIndex + 1} 页 ↗
                      </button>
                    );
                  })}
                </div>
                <div className="button-row">
                  <button
                    className="button"
                    onClick={() => {
                      try {
                        validateResponse(data, request, request.evidenceIds);
                        const id = actions.createCard(
                          request.evidenceIds,
                          request.prompt.slice(0, 36),
                          request.body,
                          research.id,
                        );
                        actions.notice('草稿已另存为观点卡片');
                        actions.openResource(
                          { kind: 'card', id },
                          { scope: data.scope, target: 'inspector' },
                        );
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    <FilePlus2 size={14} />
                    另存卡片
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      try {
                        const draft = Object.values(data.drafts).find(
                          (item) => item.researchId === research.id,
                        );
                        if (!draft) throw new Error('当前研究没有结论稿');
                        actions.updateData((data) =>
                          appendAIToDraft(data, draft.id, request),
                        );
                        actions.notice('已追加到结论，原有正文已保留');
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    追加到结论
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      actions.updateData((data) => {
                        data.requests[request.id].body = '';
                      })
                    }
                  >
                    放弃草稿
                  </button>
                </div>
              </>
            ) : (
              <p className="muted">草稿已放弃，请求记录保留。</p>
            )}
          </article>
        ))}
      </div>
      <div className="ai-composer">
        <span className="section-heading">
          已选上下文 · {conversation.contextIds.length}
        </span>
        <div className="context-chips">
          {conversation.contextIds.map((id) => {
            const evidence = data.evidence[id];
            return (
              <div className="context-chip" key={id}>
                <span>
                  {data.documents[evidence?.documentId]?.title ?? '来源缺失'} ·
                  p.{evidence?.pageIndex + 1}
                </span>
                <button
                  aria-label={`移除上下文 ${id}`}
                  className="icon-button"
                  onClick={() =>
                    actions.updateData((data) => {
                      data.conversations[conversation.id].contextIds =
                        data.conversations[conversation.id].contextIds.filter(
                          (eid) => eid !== id,
                        );
                    })
                  }
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
        {!conversation.contextIds.length && (
          <p className="muted">从证据面板选择「加入 AI 上下文」。</p>
        )}
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <textarea
          aria-label="向 AI 提问"
          value={prompt}
          onChange={(event) =>
            actions.updateData((data) => {
              data.conversations[conversation.id].input = event.target.value;
            })
          }
          placeholder="基于这些证据提问…"
        />
        <div className="composer-footer">
          <small className="muted">仅发送选定证据</small>
          <button
            className="primary send-button"
            aria-label="生成草稿"
            disabled={generating || !conversation.contextIds.length}
            onClick={() => void send()}
          >
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}
