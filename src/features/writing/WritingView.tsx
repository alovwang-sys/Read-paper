import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
  Download,
  FileText,
  History,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { useWorkspace, validateEvidence } from '../../services/workspace';
import {
  draftConversationSources,
  draftSources,
  exportMarkdown,
  insertCardReference,
  insertEvidenceReferences,
} from '../export/exportMarkdown';
import { MarkdownContent } from '../ai/MarkdownContent';
import { mapCitationNumbers } from '../../domain/citations';
import '../evidence/evidence.css';
import './writing.css';

export function WritingView({ draftId }: { draftId: string }) {
  const { data, session, actions } = useWorkspace();
  const draft = data.drafts[draftId];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const citationNumber = session.anchor?.citationNumber;
  useEffect(() => {
    if (citationNumber === undefined) return;
    setPreview(false);
    requestAnimationFrame(() => {
      const text = editor.current?.value ?? '';
      const marker = `[${citationNumber}]`, at = text.indexOf(marker);
      if (at >= 0) { editor.current?.focus(); editor.current?.setSelectionRange(at, at + marker.length); }
    });
  }, [draftId, citationNumber]);
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
  const conversationSources = draftConversationSources(draft);
  const scope = { kind: 'research' as const, researchId: draft.researchId };

  const activeCard = session.panel.ref?.kind === 'card' ? data.cards[session.panel.ref.id] : undefined;
  const numbers = new Set<number>();
  mapCitationNumbers(draft.body, number => { numbers.add(number); return ''; });
  const missingEvidence = activeCard?.evidenceIds.filter(id => !draft.evidenceIds.includes(id) || !numbers.has(draft.evidenceIds.indexOf(id) + 1)) ?? [];
  function showCitation(number: number) {
    if (!data.evidence[draft.evidenceIds[number - 1]]) { setError(`正文引用 [${number}] 没有对应的原文证据，请修复引用编号。`); return; }
    setError('');
    actions.updateData(next => { const panel = next.sessions[draft.researchId].panel; panel.open = true; panel.mode = 'cards'; panel.findEvidenceFor = undefined; panel.citation = { draftId, evidenceId: draft.evidenceIds[number - 1] ?? '' }; });
  }

  function insertCard(cardId: string) {
    try {
      const start = editor.current?.selectionStart ?? draft.body.length;
      const end = editor.current?.selectionEnd ?? start;
      let cursor = start;
      actions.updateData((next) => {
        cursor = insertCardReference(next, draftId, cardId, start, end);
      });
      setPickerOpen(false);
      setPreview(false);
      setError('');
      requestAnimationFrame(() => {
        editor.current?.focus();
        editor.current?.setSelectionRange(cursor, cursor);
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
      actions.notice('Markdown 已导出，包含论文与对话来源；未附带原始 PDF 或区域图片。');
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
        <button className="button" aria-pressed={preview} onClick={() => setPreview(!preview)}>{preview ? '编辑正文' : '预览引用'}</button>
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
                插入时会将卡片及证据论文加入本研究，保存本次使用的对话来源快照。
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
                      {card.evidenceIds.length ? `${card.evidenceIds.length} 条论文依据` : card.provenance ? '仅对话来源' : '尚无来源'}{card.needsReview ? ' · 待核查' : ''} ·{' '}
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
          {activeCard && !!missingEvidence.length && <section className="supplement-citations" aria-label="补引用"><strong>「{activeCard.title}」还有依据未引用到文稿</strong><p className="muted">在正文放置光标后，插入这些依据的引用编号。</p>{missingEvidence.map(id => <blockquote key={id}>{data.evidence[id]?.quote || '区域或失效依据'}</blockquote>)}<button className="primary" onClick={() => { try { const start = editor.current?.selectionStart ?? draft.body.length; const end = editor.current?.selectionEnd ?? start; let cursor = start; actions.updateData(next => { cursor = insertEvidenceReferences(next, draftId, missingEvidence, start, end); }); setPreview(false); requestAnimationFrame(() => { editor.current?.focus(); editor.current?.setSelectionRange(cursor, cursor); }); } catch (error) { setError((error as Error).message); } }}>在光标处补引用</button></section>}
          {preview && <section className="writing-preview" aria-label="文稿预览"><MarkdownContent text={draft.body || '尚未撰写结论。'} onCitation={showCitation} /></section>}
          <textarea
            hidden={preview}
            ref={editor}
            aria-label="结论正文"
            className="writing-editor"
            value={draft.body}
            onChange={(event) =>
              actions.updateData((next) => {
                next.drafts[draftId].body = event.target.value;
                next.drafts[draftId].updatedAt = new Date().toISOString();
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
              let valid = false;
              try { validateEvidence(data, [id]); valid = true; } catch { /* 保留失效来源，供用户修复。 */ }
              return (
                <article
                  className={`writing-source ${valid ? '' : 'is-invalid'}`}
                  key={id}
                >
                  <button className="writing-source-number text-button" aria-label={`查看出处链 [${index + 1}]`} onClick={() => showCitation(index + 1)}>[{index + 1}]</button>
                  <div className="writing-source-content">
                    <strong>{document?.title ?? '文献或证据已缺失'}</strong>
                    <div className="muted">
                      {document?.authors} {document?.year}{' '}
                      {evidence && `· PDF 第 ${evidence.pageIndex + 1} 页`}
                      {evidence?.printedPage &&
                        ` · 印刷页码 ${evidence.printedPage}`}
                    </div>
                    <blockquote>
                      {evidence?.kind === 'region' && <span>区域证据 · </span>}
                      {evidence?.quote || (valid && evidence?.kind === 'region' ? '保存的 PDF 框选区域，点击查看原文。' : '请修复这条引用后导出。')}
                    </blockquote>
                    {valid && evidence && document && (
                      <button
                        className="button"
                        onClick={() => {
                          try {
                            actions.updateData(next => { next.sessions[draft.researchId].panel.citation = undefined; next.sessions[draft.researchId].panel.findEvidenceFor = undefined; });
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
          {!!conversationSources.length && <section className="writing-sources" aria-label="结论相关对话来源">
            <div className="section-heading"><h3>相关对话来源</h3><span className="badge">{conversationSources.length} 条</span></div>
            <p className="muted">以下为插入卡片时的来源快照，后续编辑卡片不会改写这些记录。</p>
            {conversationSources.map(({ provenance, cardIds, titles }) => <article className="conversation-source" key={JSON.stringify([provenance.requestId, provenance.selection || provenance.answer])}>
              <strong>{titles.join(' · ')}</strong>
              <p className="muted">{provenance.conversationTitle || '阅读对话'} · {provenance.createdAt}</p>
              <p>原始问题：{provenance.prompt}</p>
              <blockquote>{provenance.selection || provenance.answer}</blockquote>
              <button className="button" onClick={() => actions.openConversationSource(provenance, { kind: 'draft', id: draftId })} aria-label={`查看相关对话：${titles.join(' · ')}`}><History size={14} />查看相关对话</button>
              <p className="muted">卡片 ID：{cardIds.join('、')}</p>
            </article>)}
          </section>}
          <p className="writing-export-note muted">
            Markdown 导出包含文献信息、PDF 页码、摘录、区域说明与已用卡片的对话快照，不附带原始 PDF 或区域图片。
          </p>
        </div>
      </div>
    </div>
  );
}
