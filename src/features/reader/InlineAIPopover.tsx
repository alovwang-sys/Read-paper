import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUp, Check, ChevronRight, Layers, Square, X } from 'lucide-react';
import { commitCardDraft, retryAI, snapshotContext, stopAI, submitAI } from '../../services/ai';
import { continueInlineInPanel, createInlineCardDraft, inlineAIConfig } from '../../services/inline-ai';
import { useWorkspace } from '../../services/workspace';
import { MarkdownContent } from '../ai/MarkdownContent';
import './inline-ai.css';

export type ReaderSelectionAnchor = { left: number; top: number; width: number; height: number };

/** The reader owns the anchor; the portal keeps a small pane from clipping its controls. */
export function ReaderPopover({ anchor, pageElement, boundary, className, label, children }: {
  anchor: ReaderSelectionAnchor; pageElement?: HTMLElement | null; boundary: HTMLElement | null;
  className: string; label?: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !boundary || !pageElement) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const bounds = boundary.getBoundingClientRect(), page = pageElement.getBoundingClientRect();
        const left = Math.max(8, bounds.left + 8), right = Math.min(window.innerWidth - 8, bounds.right - 8);
        const top = Math.max(8, bounds.top + 8), bottom = Math.min(window.innerHeight - 8, bounds.bottom - 8);
        const start = page.top + anchor.top, end = start + anchor.height;
        const width = Math.max(120, Math.min(className.includes('inline-ai') ? 430 : 560, right - left));
        const maxHeight = Math.max(80, Math.min(className.includes('inline-ai') ? 520 : 300, bottom - top));
        node.style.width = `${width}px`;
        node.style.maxHeight = `${maxHeight}px`;
        const height = Math.min(node.offsetHeight, maxHeight);
        const below = bottom - end - 8, above = start - top - 8;
        const y = below >= height || below >= above ? end + 8 : start - height - 8;
        const next: CSSProperties = {
          position: 'fixed', width, maxHeight,
          left: Math.max(left, Math.min(page.left + anchor.left, right - width)),
          top: Math.max(top, Math.min(y, bottom - height)),
          visibility: end < top || start > bottom || right <= left || bottom <= top ? 'hidden' : 'visible',
        };
        setPosition(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node); observer.observe(boundary); observer.observe(pageElement);
    boundary.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); boundary.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [anchor, pageElement, boundary, className]);
  return createPortal(<div ref={box} className={`reader-popover ${className}`} aria-label={label} style={position}>{children}</div>, document.body);
}

export function InlineAIPopover({ conversationId, initialAction, onClose, onSource }: {
  conversationId: string; initialAction: 'explain' | 'ask'; onClose: () => void; onSource: (evidenceId: string) => void;
}) {
  const { data, actions, saveStatus } = useWorkspace();
  const conversation = data.conversations[conversationId];
  const source = conversation?.inlineSource;
  const evidence = source && data.evidence[source.evidenceId];
  let materials: ReturnType<typeof snapshotContext> = [], scopeProblem = '';
  if (conversation) {
    try { materials = snapshotContext(data, conversation.researchId, conversationId); }
    catch (error) { scopeProblem = error instanceof Error ? error.message : '来源暂不可用，请重新选择材料。'; }
  }
  const onlyOriginal = materials.length === 1 && materials[0].evidenceId === source?.evidenceId;
  const requests = conversation?.requestIds.map(id => data.requests[id]).filter(request => request && !request.superseded && (!request.purpose || request.purpose === 'chat')) ?? [];
  const latest = requests.at(-1);
  const generating = requests.find(request => request.status === 'generating');
  const [preparing, setPreparing] = useState(false);
  const [problem, setProblem] = useState('');
  const [draftOpen, setDraftOpen] = useState(false);
  const draft = source?.draftId ? data.cardDrafts[source.draftId] : undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const requestBusy = useRef(false);
  const followOutput = useRef(true);
  const busy = preparing || !!generating;
  const close = () => onClose();
  async function ask(prompt: string) {
    if (!conversation || requestBusy.current || busy || !prompt.trim()) return;
    if (scopeProblem) { setProblem(scopeProblem); return; }
    requestBusy.current = true; setPreparing(true); setProblem('');
    try {
      const config = await inlineAIConfig(conversation.researchId, conversationId);
      if (materials.some(item => item.kind === 'region') && !config.images) throw new Error('当前模型未开启图片理解。区域已保留，可改选文字，或在设置中配置支持图片的模型。');
      followOutput.current = true;
      await submitAI(conversation.researchId, conversationId, prompt);
    } catch (error) { setProblem(error instanceof Error ? error.message : '暂时无法回答，请重试。'); }
    finally { requestBusy.current = false; setPreparing(false); }
  }
  useEffect(() => {
    input.current?.focus();
    if (!started.current && initialAction === 'explain' && !requests.length) {
      started.current = true;
      void ask('请用容易理解的中文解释这段原文的意思，再点出理解它所需的关键概念。区分原文结论和补充解释，回答简洁。');
    }
  }, [conversationId]);
  useEffect(() => {
    const node = content.current;
    if (node && followOutput.current) node.scrollTop = node.scrollHeight;
  }, [latest?.body, latest?.status, requests.length, problem]);
  if (!conversation || !source || !evidence) return <div className="inline-ai-missing"><p>这次提问的来源已不存在。</p><button className="button" onClick={close}>返回阅读</button></div>;
  const updateInput = (value: string) => actions.updateData(next => { if (next.conversations[conversationId]) next.conversations[conversationId].input = value; });
  const run = (operation: () => void) => { setProblem(''); try { operation(); } catch (error) { setProblem(error instanceof Error ? error.message : '操作失败，内容已保留。'); } };
  const retry = async () => {
    if (!latest || requestBusy.current || busy || scopeProblem) return;
    requestBusy.current = true; setPreparing(true); setProblem('');
    try { await inlineAIConfig(conversation.researchId, conversationId); await retryAI(latest.id); }
    catch (error) { setProblem(error instanceof Error ? error.message : '重试失败，请稍后再试。'); }
    finally { requestBusy.current = false; setPreparing(false); }
  };
  const updateDraft = (field: 'title' | 'body', value: string) => actions.updateData(next => {
    const current = source.draftId && next.cardDrafts[source.draftId];
    if (current && current.status !== 'saved') { current[field] = value; current.revision++; current.status = 'editing'; }
  });
  return <section className="inline-ai-dialog" role="dialog" aria-label="原文旁提问" onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }}>
    <header className="inline-ai-header">
      {draftOpen && <button className="icon-button" aria-label="返回就地问答并保留卡片草稿" onClick={() => setDraftOpen(false)}><ArrowLeft size={15} /></button>}
      <strong>{draftOpen ? draft?.status === 'saved' ? '卡片已保存' : '整理为卡片' : '解释与提问'}</strong>
      <span>PDF 第 {source.pageIndex + 1} 页</span>
      <button className="icon-button" aria-label="关闭就地问答并保留内容" title="收起，内容会保留 · Esc" onClick={close}><X size={15} /></button>
    </header>
    <details className="inline-ai-source"><summary>{scopeProblem ? '材料暂不可用' : onlyOriginal ? `仅所选${evidence.kind === 'region' ? '区域' : '原文'}` : `本轮材料 · ${materials.length}`}<span>查看来源</span></summary><div className="inline-ai-materials">{scopeProblem ? <p role="alert">{scopeProblem}</p> : materials.map(item => <div key={item.evidenceId}>{!onlyOriginal && <strong>{item.title} · PDF 第 {item.pageIndex + 1} 页</strong>}<blockquote>{item.quote || `PDF 第 ${item.pageIndex + 1} 页的框选区域`}</blockquote></div>)}</div></details>
    {draftOpen && draft ? <>
      <div className="inline-ai-draft">
        {draft.status === 'saved' ? <><h3>{draft.title}</h3><MarkdownContent text={draft.body} onCitation={number => draft.evidenceIds[number - 1] && onSource(draft.evidenceIds[number - 1])} /><p className="inline-ai-saved" role="status"><Check size={13} />{saveStatus === 'error' ? '本地保存失败，草稿仍保留' : '已加入当前研究的卡片，原文和问答来源一并保留。'}{saveStatus === 'error' && <button className="text-button" onClick={() => actions.retrySave()}>重试保存</button>}</p></> : <>
          <label>标题<input aria-label="就地卡片标题" value={draft.title} maxLength={200} onChange={event => updateDraft('title', event.target.value)} /></label>
          <label>正文<textarea aria-label="就地卡片正文" value={draft.body} onChange={event => updateDraft('body', event.target.value)} /></label>
          <label className="inline-ai-review"><input type="checkbox" checked={draft.needsReview} onChange={event => actions.updateData(next => { next.cardDrafts[draft.id].needsReview = event.target.checked; })} />待核查</label>
        </>}
      </div>
      {draft.status !== 'saved' && <div className="inline-ai-draft-footer"><span>编辑确认后保存 · 保留原文与问答来源</span><button className="primary" disabled={!draft.title.trim() || !draft.body.trim()} onClick={() => run(() => { commitCardDraft(draft.id); })}>保存卡片</button></div>}
    </> : <>
      <div ref={content} className="inline-ai-content" onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 50; }}>
        {!requests.length && !busy && <p className="inline-ai-empty">这段哪里不明白？可以直接问。</p>}
        {requests.map((request, index) => <article className="inline-ai-turn" key={request.id}>
          <p className="inline-ai-question">{index === 0 && initialAction === 'explain' && request.prompt.startsWith('请用容易理解') ? '解释这段' : request.prompt}</p>
          {request.body && <MarkdownContent text={request.body} onCitation={number => {
            const ids = request.status === 'done' ? request.evidenceIds : request.context.map(item => item.evidenceId);
            if (ids[number - 1]) onSource(ids[number - 1]);
          }} />}
          {request.status === 'generating' && <p className="inline-ai-working" role="status">{request.body ? '正在回答…' : '正在理解所选内容…'}</p>}
          {request.status !== 'done' && request.status !== 'generating' && <div className="inline-ai-request-error" role={request.status === 'stopped' ? 'status' : 'alert'}><span>{request.error || '回答未完成，已有内容已保留。'}</span>{index === requests.length - 1 && <button className="text-button" disabled={busy} onClick={() => void retry()}>重试</button>}</div>}
          {request.mode === 'demo' && <span className="inline-ai-demo">演示回答</span>}
        </article>)}
        {preparing && !generating && !latest && <p className="inline-ai-working" role="status">正在连接阅读助手…</p>}
      </div>
      <div className="inline-ai-answer-actions">
        {latest?.status === 'done' && !latest.validationError && <button className="text-button" onClick={() => run(() => { createInlineCardDraft(latest.id); setDraftOpen(true); })}><Layers size={13} />{draft?.source.requestId === latest.id ? draft.status === 'saved' ? '查看已存卡片' : '查看卡片草稿' : '收为卡片'}</button>}
        <button className="text-button" onClick={() => run(() => { continueInlineInPanel(conversationId); close(); })}>在右侧继续<ChevronRight size={13} /></button>
      </div>
      <form className="inline-ai-composer" onSubmit={event => { event.preventDefault(); void ask(conversation.input ?? ''); }}>
        <textarea ref={input} rows={2} aria-label="向原文旁助手提问" placeholder={requests.length ? '继续问这段原文…' : '这段是什么意思？'} value={conversation.input ?? ''} onChange={event => updateInput(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(conversation.input ?? ''); }
        }} />
        {busy ? <button className="inline-ai-send" type="button" aria-label="停止就地回答" disabled={!generating} onClick={() => generating && stopAI(generating.id)}><Square size={13} /></button> : <button className="inline-ai-send" type="submit" aria-label="发送就地问题" disabled={!conversation.input?.trim() || !!scopeProblem}><ArrowUp size={16} /></button>}
      </form>
    </>}
    {problem && <div className="inline-ai-problem" role="alert">{problem}{!requests.length && initialAction === 'explain' && <button className="text-button" disabled={busy} onClick={() => void ask('请用容易理解的中文解释这段原文的意思，区分原文与补充解释。')}>重试解释</button>}</div>}
  </section>;
}
