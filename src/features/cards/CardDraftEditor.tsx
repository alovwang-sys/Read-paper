import { useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  History,
  Layers,
  Sparkles,
  Undo2,
} from 'lucide-react';
import type { CardProvenance } from '../../domain/types';
import {
  applyCardRevision,
  commitCardDraft,
  demoResponder,
  discardCardDraft,
  retryCardDraft,
  reviseCardDraft,
  undoCardRevision,
} from '../../services/ai';
import { useWorkspace } from '../../services/workspace';
import { MarkdownContent } from '../ai/MarkdownContent';
import { hasOriginalDocument } from '../ai/SourceDetails';

export function CardDraftEditor({
  draftId,
  demo,
  onBack,
  onSource,
}: {
  draftId: string;
  demo: boolean;
  onBack: () => void;
  onSource: (source: CardProvenance) => void;
}) {
  const { data, actions, saveStatus, saveError } = useWorkspace();
  const [error, setError] = useState('');
  const [revising, setRevising] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const draft = data.cardDrafts[draftId];
  if (!draft)
    return (
      <div className="ai-empty">
        <Layers />
        <h3>这份草稿已不存在</h3>
        <button className="button" onClick={onBack}>
          返回对话
        </button>
      </div>
    );
  const busy = draft.status === 'generating';
  const saving = busy && !draft.body.trim();
  const saved = draft.status === 'saved';
  const expired =
    draft.suggestion && draft.suggestion.baseRevision !== draft.revision;
  const update = (field: 'title' | 'body', value: string) =>
    actions.updateData((next) => {
      const current = next.cardDrafts[draftId];
      current[field] = value;
      current.revision++;
      if (current.status !== 'generating') current.status = 'editing';
    });
  const execute = (action: () => void) => {
    setError('');
    try {
      action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '操作失败，草稿已保留',
      );
    }
  };
  async function executeAsync(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : '重试失败，草稿已保留',
      );
    }
  }
  async function revise() {
    setError('');
    setRevising(true);
    try {
      await reviseCardDraft(
        draftId,
        draft.instruction ?? '',
        demo ? demoResponder : undefined,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '修订失败，请重试');
    } finally {
      setRevising(false);
    }
  }
  const openCard = () =>
    draft.cardId &&
    actions.openResource(
      { kind: 'card', id: draft.cardId },
      {
        scope: { kind: 'research', researchId: draft.researchId },
        target: 'inspector',
      },
    );
  return (
    <section className="ai-card-draft" aria-label="AI 卡片草稿">
      <div className="ai-subhead">
        <button
          className="icon-button"
          aria-label="返回对话并保留草稿"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </button>
        <h3>{saved ? '卡片已建立' : '卡片草稿'}</h3>
        <span className="ai-badge">
          {saving
            ? '正在整理'
            : saved && saveStatus === 'saved'
              ? '已保存'
              : saveStatus === 'error'
                ? '保存失败'
                : saved
                  ? '保存中'
                  : '待确认'}
        </span>
      </div>
      <div className={`ai-model-bar ${demo ? 'is-demo' : ''}`} role="status">
        <Sparkles size={13} />
        <span>
          {demo
            ? '演示模式 · 整理与修订使用预设内容'
            : '真实模型 · AI 修订会发送当前草稿与来源'}
        </span>
      </div>
      <div className="ai-content-scroll">
        <div className="ai-draft-intro">
          <Layers size={24} />
          <div>
            <h3>{saved ? '把理解，留下来了。' : '把理解，留下来。'}</h3>
            <p>
              {saved
                ? '已加入当前研究；来源随卡片保留。'
                : '独立草稿，可修改后加入卡片。'}
            </p>
          </div>
        </div>
        {saving && (
          <p className="ai-info" role="status">
            AI 正在整理知识点，原始问答已保留…
          </p>
        )}
        {draft.error && (
          <div className="ai-error" role="alert">
            <p>{draft.error}</p>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void executeAsync(() =>
                  draft.body.trim()
                    ? reviseCardDraft(
                        draftId,
                        draft.instruction || '保留原意，重新整理标题和正文。',
                        demo ? demoResponder : undefined,
                      )
                    : retryCardDraft(draftId, demo ? demoResponder : undefined),
                )
              }
            >
              按原草稿重试
            </button>
          </div>
        )}
        {saved ? (
          <>
            <h2 className="ai-saved-title">{draft.title}</h2>
            <MarkdownContent text={draft.body} />
          </>
        ) : (
          <>
            <label className="ai-field">
              卡片标题
              <input
                aria-label="卡片标题"
                value={draft.title}
                disabled={saving}
                placeholder="用一句话表达一个观点"
                onChange={(event) => update('title', event.target.value)}
              />
            </label>
            <label className="ai-field">
              你的理解
              <textarea
                className="ai-draft-body"
                aria-label="卡片正文"
                value={draft.body}
                disabled={saving}
                placeholder="观点、适用条件与仍需核查的限制…"
                onChange={(event) => update('body', event.target.value)}
              />
            </label>
            <label className="ai-checkbox">
              <input
                type="checkbox"
                checked={draft.needsReview}
                onChange={(event) =>
                  actions.updateData((next) => {
                    next.cardDrafts[draftId].needsReview = event.target.checked;
                  })
                }
              />
              待核查
            </label>
          </>
        )}
        <div className="ai-source-box">
          <h4>保留这次理解的来处</h4>
          {draft.evidenceIds.length ? (
            draft.evidenceIds.map((id, index) => {
              const evidence = data.evidence[id];
              const snapshot = draft.source.context.find(
                (item) => item.evidenceId === id,
              );
              const doc = evidence && data.documents[evidence.documentId];
              return (
                <button
                  className="ai-source-item"
                  key={id}
                  disabled={!snapshot || !hasOriginalDocument(data, snapshot)}
                  onClick={() =>
                    execute(() => {
                      if (!snapshot || !hasOriginalDocument(data, snapshot))
                        throw new Error(
                          '原文证据缺失，仍可查阅相关对话中的摘录',
                        );
                      actions.openResource(
                        { kind: 'document', id: snapshot.documentId },
                        {
                          scope: data.scope,
                          target: 'inspector',
                          anchor: {
                            evidenceId: evidence?.documentId === snapshot.documentId && evidence.pageIndex === snapshot.pageIndex && evidence.quote === snapshot.quote ? id : undefined,
                            pageIndex: snapshot.pageIndex,
                          },
                        },
                      );
                    })
                  }
                >
                  <strong>
                    <BookOpen size={14} />
                    论文依据 [{index + 1}] · PDF 第{' '}
                    {(snapshot?.pageIndex ?? evidence?.pageIndex ?? 0) + 1} 页
                  </strong>
                  <span>{doc?.title ?? snapshot?.title ?? '原文暂不可用'}</span>
                  <small>{snapshot?.quote ?? evidence?.quote}</small>
                  <em>{hasOriginalDocument(data, snapshot) ? '查看原文 →' : '原文件缺失或版本变化，保留了来源快照'}</em>
                </button>
              );
            })
          ) : (
            <p className="ai-info">仅对话来源 · 尚未建立直接论文依据。</p>
          )}
          <button
            className="ai-source-item"
            onClick={() => onSource(draft.source)}
          >
            <strong>
              <History size={14} />
              相关对话
            </strong>
            <span>{draft.source.prompt}</span>
            <em>查看原始问答{draft.source.selection ? '与整理片段' : ''} →</em>
          </button>
        </div>
        {!saved && (
          <section className="ai-revision" aria-label="AI 修订卡片">
            <h4>
              <Sparkles size={15} />请 AI 帮我修订
            </h4>
            <label className="ai-field">
              <span className="sr-only">AI 修订要求</span>
              <textarea
                aria-label="AI 修订要求"
                value={draft.instruction ?? ''}
                disabled={busy || revising}
                placeholder="例如：压缩到 120 字，突出适用条件"
                onChange={(event) =>
                  actions.updateData((next) => {
                    next.cardDrafts[draftId].instruction = event.target.value;
                  })
                }
              />
            </label>
            <button
              className="button"
              disabled={
                busy ||
                revising ||
                !draft.body.trim() ||
                !draft.instruction?.trim()
              }
              onClick={() => void revise()}
            >
              {busy || revising
                ? '正在生成修订建议…'
                : `生成${demo ? '演示' : ''}修订建议`}
            </button>
            {draft.suggestion && (
              <div className="ai-revision-preview">
                <span className="ai-badge">独立预览 · 尚未应用</span>
                {expired && (
                  <p className="ai-error">
                    正文已变化，这份建议基于较早版本。请重新生成，避免覆盖新输入。
                  </p>
                )}
                <h4>{draft.suggestion.title}</h4>
                <MarkdownContent text={draft.suggestion.body} />
                <div className="ai-actions">
                  <button
                    className="primary"
                    disabled={!!expired || revising}
                    onClick={() => execute(() => applyCardRevision(draftId))}
                  >
                    应用修改
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      actions.updateData((next) => {
                        next.cardDrafts[draftId].suggestion = undefined;
                      })
                    }
                  >
                    取消建议
                  </button>
                </div>
              </div>
            )}
            {draft.previous && (
              <button
                className="text-button"
                onClick={() => execute(() => undoCardRevision(draftId))}
              >
                <Undo2 size={14} />
                恢复应用前的正文
              </button>
            )}
          </section>
        )}
        <p className="ai-footnote">
          论文用于核对事实，对话保留解释过程。引用可定位仍需核查观点。返回、收起面板或切换研究会保留草稿。
        </p>
        {error && (
          <p className="ai-error" role="alert">
            {error}
          </p>
        )}
        {saveStatus === 'error' && (
          <div className="ai-error" role="alert">
            <p>{saveError ?? '本地保存失败，编辑内容已保留。'}</p>
            <button className="button" onClick={() => actions.retrySave()}>
              重试本地保存
            </button>
          </div>
        )}
        {discarding && (
          <div className="ai-info">
            <p>放弃这份草稿？原始问答和已保存卡片仍保留。</p>
            <div className="ai-actions">
              <button
                className="button"
                onClick={() =>
                  execute(() => {
                    discardCardDraft(draftId);
                    onBack();
                  })
                }
              >
                确认放弃
              </button>
              <button
                className="text-button"
                onClick={() => setDiscarding(false)}
              >
                继续编辑
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="ai-panel-footer">
        {saved ? (
          <>
            <button className="button" onClick={openCard}>
              <Check size={14} />
              查看卡片
            </button>
            <button className="primary" onClick={onBack}>
              继续对话
            </button>
          </>
        ) : (
          <>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setDiscarding(true)}
            >
              放弃草稿
            </button>
            <button
              className="primary"
              disabled={
                busy || revising || !draft.title.trim() || !draft.body.trim()
              }
              onClick={() =>
                execute(() => {
                  commitCardDraft(draftId);
                })
              }
            >
              <Layers size={14} />
              加入卡片
            </button>
          </>
        )}
      </div>
    </section>
  );
}
