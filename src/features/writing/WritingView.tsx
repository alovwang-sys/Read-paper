import { useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Download,
  FileText,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import {
  draftSources,
  exportMarkdown,
  remapCitationNumbers,
} from '../export/exportMarkdown';
import './writing.css';

export function WritingView({ draftId }: { draftId: string }) {
  const { data, actions } = useWorkspace();
  const draft = data.drafts[draftId];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  if (!draft)
    return (
      <div className="empty-state">
        <FileText />
        <h2>结论稿已缺失</h2>
        <p>请从研究概览打开其他结论稿。</p>
      </div>
    );
  const research = data.researches[draft.researchId];
  let validationError = '';
  try {
    draftSources(data, draftId);
  } catch (problem) {
    validationError =
      problem instanceof Error ? problem.message : '引用校验失败';
  }
  const cards = Object.values(data.cards).filter((card) =>
    `${card.title} ${card.body}`.toLowerCase().includes(query.toLowerCase()),
  );
  const sources = [...new Set(draft.evidenceIds)];
  const scope = { kind: 'research' as const, researchId: draft.researchId };

  function insertCard(cardId: string) {
    try {
      const card = data.cards[cardId];
      if (!card.evidenceIds.length)
        throw new Error('这张卡片尚无原文证据，请先为卡片添加来源。');
      const evidenceIds = [
        ...new Set([...draft.evidenceIds, ...card.evidenceIds]),
      ];
      const body = remapCitationNumbers(
        card.body.trim() || card.title,
        card.evidenceIds,
        evidenceIds,
      );
      const markers = [...new Set(card.evidenceIds)]
        .map((id) => `[${evidenceIds.indexOf(id) + 1}]`)
        .filter((marker) => !body.includes(marker))
        .join('');
      const text = `${body}${markers ? ` ${markers}` : ''}`;
      actions.associateCard(draft.researchId, cardId);
      const start = editor.current?.selectionStart ?? draft.body.length;
      const end = editor.current?.selectionEnd ?? start;
      const insertion = `${start > 0 ? '\n\n' : ''}${text}${end < draft.body.length ? '\n\n' : ''}`;
      actions.updateData((next) => {
        next.drafts[draftId].evidenceIds = evidenceIds;
        next.drafts[draftId].body =
          draft.body.slice(0, start) + insertion + draft.body.slice(end);
      });
      setPickerOpen(false);
      setError('');
      requestAnimationFrame(() => {
        editor.current?.focus();
        editor.current?.setSelectionRange(
          start + insertion.length,
          start + insertion.length,
        );
      });
    } catch (problem) {
      setError(
        problem instanceof Error
          ? problem.message
          : '插入失败，请检查卡片来源。',
      );
    }
  }

  function download() {
    try {
      const content = exportMarkdown(data, draftId);
      const url = URL.createObjectURL(
        new Blob([content], { type: 'text/markdown;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${draft.title.replace(/[\\/:*?"<>|]/g, '-').trim() || '研究结论'}.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError('');
      actions.notice('Markdown 已导出，包含引用与摘录，未附带原始 PDF。');
    } catch (problem) {
      setError(
        problem instanceof Error ? problem.message : '导出失败，请重试。',
      );
    }
  }

  return (
    <div className="writing-view">
      <div className="toolbar writing-toolbar">
        <div className="writing-toolbar-label">
          <FileText size={16} />
          <span>结论稿</span>
          <span className="muted">· 自动保存</span>
        </div>
        <button
          className="button"
          onClick={() => {
            setPickerOpen(!pickerOpen);
            setError('');
          }}
          aria-expanded={pickerOpen}
        >
          <Plus size={15} />
          插入卡片引用
        </button>
        <button
          className="button primary"
          onClick={download}
          disabled={!!validationError}
        >
          <Download size={15} />
          导出 Markdown
        </button>
      </div>
      <div className="writing-scroll">
        <div className="writing-page">
          <div className="writing-eyebrow">
            RESEARCH NOTES <span>·</span> {research?.title ?? '所属研究已缺失'}
          </div>
          <input
            aria-label="结论标题"
            className="writing-title"
            value={draft.title}
            onChange={(event) =>
              actions.updateData((next) => {
                next.drafts[draftId].title = event.target.value;
              })
            }
            placeholder="为研究结论命名"
          />
          <div className="writing-question">
            <BookOpen size={16} />
            <div>
              <span>研究问题</span>
              <p>{research?.question || '尚未填写研究问题'}</p>
            </div>
          </div>
          {(error || validationError) && (
            <div className="writing-error" role="alert">
              {error || validationError}
            </div>
          )}
          {pickerOpen && (
            <section className="writing-picker" aria-label="选择引用卡片">
              <div className="section-heading">
                <strong>从卡片写入观点与来源</strong>
                <button
                  className="icon-button"
                  aria-label="关闭引用选择"
                  onClick={() => setPickerOpen(false)}
                >
                  <X size={16} />
                </button>
              </div>
              <label className="writing-search">
                <Search size={16} />
                <input
                  autoFocus
                  aria-label="搜索引用卡片"
                  placeholder="搜索全部卡片"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <p className="muted">
                插入时会将卡片及证据论文加入本研究，原文证据保留在稿末。
              </p>
              <div className="writing-picker-list">
                {cards.map((card) => (
                  <button
                    className="writing-picker-card"
                    key={card.id}
                    onClick={() => insertCard(card.id)}
                    aria-label={`插入引用：${card.title}`}
                  >
                    <strong>{card.title}</strong>
                    <span>{card.body.slice(0, 95)}</span>
                    <small>
                      {card.evidenceIds.length} 条来源 ·{' '}
                      {research?.cardIds.includes(card.id)
                        ? '已在研究中'
                        : '加入研究并引用'}
                    </small>
                  </button>
                ))}
                {!cards.length && (
                  <p className="muted">
                    没有匹配的卡片。可先从 PDF 原文创建证据卡片。
                  </p>
                )}
              </div>
            </section>
          )}
          <div className="writing-body-heading">
            <span>研究结论</span>
            <span className="muted">{draft.body.length} 字符</span>
          </div>
          <textarea
            ref={editor}
            aria-label="结论正文"
            className="writing-editor"
            value={draft.body}
            onChange={(event) =>
              actions.updateData((next) => {
                next.drafts[draftId].body = event.target.value;
              })
            }
            placeholder="写下研究结论、适用条件与仍待验证的问题。使用「插入卡片引用」保留支持观点的证据。"
          />
          <section className="writing-sources" aria-label="结论引用来源">
            <div className="section-heading">
              <h3>引用与原文证据</h3>
              <span className="badge">{sources.length} 条</span>
            </div>
            <p className="muted">
              正文中的 [n] 对应以下来源。点击可在右侧核查原文。
            </p>
            {!sources.length && (
              <p className="writing-no-source">
                尚无来源。插入卡片引用，为结论保留可核查的证据。
              </p>
            )}
            {sources.map((id, index) => {
              const evidence = data.evidence[id],
                document = evidence && data.documents[evidence.documentId];
              const valid =
                evidence &&
                document &&
                Number.isInteger(evidence.pageIndex) &&
                evidence.pageIndex >= 0 &&
                evidence.pageIndex < document.pageCount &&
                evidence.quote.trim();
              return (
                <article
                  className={`writing-source ${valid ? '' : 'is-invalid'}`}
                  key={id}
                >
                  <div className="writing-source-number">[{index + 1}]</div>
                  <div className="writing-source-content">
                    <strong>{document?.title ?? '文献或证据已缺失'}</strong>
                    <div className="muted">
                      {document?.authors} {document?.year}{' '}
                      {evidence && `· PDF 第 ${evidence.pageIndex + 1} 页`}
                      {evidence?.printedPage &&
                        ` · 印刷页码 ${evidence.printedPage}`}
                    </div>
                    <blockquote>
                      {evidence?.quote || '请修复这条引用后导出。'}
                    </blockquote>
                    {valid && (
                      <button
                        className="button"
                        onClick={() => {
                          try {
                            actions.openResource(
                              { kind: 'document', id: document.id },
                              {
                                scope,
                                target: 'inspector',
                                anchor: {
                                  evidenceId: id,
                                  pageIndex: evidence.pageIndex,
                                },
                              },
                            );
                            setError('');
                          } catch (problem) {
                            setError(
                              problem instanceof Error
                                ? problem.message
                                : '来源无法打开，请修复引用。',
                            );
                          }
                        }}
                      >
                        <ArrowUpRight size={14} />
                        查看原文
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
          <p className="writing-export-note muted">
            Markdown 导出包含文献信息、PDF 页码与原文摘录，不附带原始 PDF。
          </p>
        </div>
      </div>
    </div>
  );
}
