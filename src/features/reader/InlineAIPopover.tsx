import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUp, Check, ChevronRight, GripHorizontal, Layers, MoveDiagonal2, Square, X } from 'lucide-react';
import { commitCardDraft, resumeNativeRuns, retryAI, skipPaperBrief, snapshotContext, steerNativeRun, stopAI, submitAI } from '../../services/ai';
import { continueInlineInPanel, createInlineCardDraft, inlineAIConfig } from '../../services/inline-ai';
import { useWorkspace } from '../../services/workspace';
import { readerActivities } from '../../services/reader-actions';
import { pageRangeLabel } from '../../domain/evidence';
import { MarkdownContent } from '../ai/MarkdownContent';
import { NativeRunTimeline } from '../ai/NativeRunTimeline';
import { RenameConversationButton } from '../ai/ConversationManagement';
import { constrainPopover, type PopoverRect } from './popover-layout';
import './inline-ai.css';

export type ReaderSelectionAnchor = { left: number; top: number; width: number; height: number };

/** The reader owns the anchor; the portal keeps a small pane from clipping its controls. */
export function ReaderPopover({ anchor, pageElement, boundary, className, label, children }: {
  anchor: ReaderSelectionAnchor; pageElement?: HTMLElement | null; boundary: HTMLElement | null;
  className: string; label?: string; children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const manualRect = useRef<PopoverRect | null>(null);
  const pointer = useRef<{ id: number; mode: 'move' | 'resize'; x: number; y: number; rect: PopoverRect } | null>(null);
  const movable = className.includes('inline-ai');
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' });
  const place = (rect: PopoverRect, resizing = false) => {
    const bounded = resizing ? { ...rect, width: Math.min(rect.width, window.innerWidth - 8 - rect.left), height: Math.min(rect.height, window.innerHeight - 8 - rect.top) } : rect;
    const next = constrainPopover(bounded, { width: window.innerWidth, height: window.innerHeight }, resizing ? { width: 320, height: 280 } : undefined);
    manualRect.current = next;
    setPosition({ position: 'fixed', ...next, maxHeight: next.height, visibility: 'visible' });
  };
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !boundary || !pageElement) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (manualRect.current) { place(manualRect.current); return; }
        const bounds = boundary.getBoundingClientRect(), page = pageElement.getBoundingClientRect();
        const left = movable ? 8 : Math.max(8, bounds.left + 8), right = movable ? window.innerWidth - 8 : Math.min(window.innerWidth - 8, bounds.right - 8);
        const top = movable ? 8 : Math.max(8, bounds.top + 8), bottom = movable ? window.innerHeight - 8 : Math.min(window.innerHeight - 8, bounds.bottom - 8);
        const start = page.top + anchor.top, end = start + anchor.height;
        const width = Math.max(120, Math.min(className.includes('inline-ai') ? 430 : 376, right - left));
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
          visibility: end < Math.max(top, bounds.top) || start > Math.min(bottom, bounds.bottom) || right <= left || bottom <= top ? 'hidden' : 'visible',
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
  }, [anchor, pageElement, boundary, className, movable]);
  return createPortal(<div ref={box} className={`reader-popover ${className}`} aria-label={label} style={position}
    onPointerDown={event => {
      if (!movable || event.button !== 0) return;
      const target = event.target as HTMLElement;
      const handle = target.closest('[data-popover-drag], [data-popover-resize]');
      if (!handle || target.closest('button, a, input, textarea, summary') && !target.closest('[data-popover-move], [data-popover-resize]')) return;
      const rect = event.currentTarget.getBoundingClientRect();
      pointer.current = { id: event.pointerId, mode: handle.hasAttribute('data-popover-resize') ? 'resize' : 'move', x: event.clientX, y: event.clientY, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }}
    onPointerMove={event => {
      const active = pointer.current;
      if (!active || active.id !== event.pointerId) return;
      const dx = event.clientX - active.x, dy = event.clientY - active.y;
      place(active.mode === 'move' ? { ...active.rect, left: active.rect.left + dx, top: active.rect.top + dy } : { ...active.rect, width: active.rect.width + dx, height: active.rect.height + dy }, active.mode === 'resize');
    }}
    onPointerUp={event => { if (pointer.current?.id === event.pointerId) { pointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { pointer.current = null; }} onLostPointerCapture={() => { pointer.current = null; }}
    onKeyDownCapture={event => {
      const target = event.target as HTMLElement;
      const resizing = target.hasAttribute('data-popover-resize');
      if (!movable || !resizing && !target.hasAttribute('data-popover-move') || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect(), step = event.shiftKey ? 40 : 10;
      const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
      const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      place({ left: rect.left + (resizing ? 0 : dx), top: rect.top + (resizing ? 0 : dy), width: rect.width + (resizing ? dx : 0), height: rect.height + (resizing ? dy : 0) }, resizing);
    }}>
    {children}
  </div>, document.body);
}

export function InlineAIPopover({ conversationId, initialAction, onClose, onSource, onMarkChange }: {
  conversationId: string; initialAction: 'explain' | 'ask' | 'translation' | 'summary'; onClose: () => void; onSource: (evidenceId: string) => void;
  onMarkChange: (evidenceId: string, marked: boolean) => void;
}) {
  const { data, actions, saveStatus } = useWorkspace();
  const conversation = data.conversations[conversationId];
  const deleted = !!conversation?.deletedAt;
  useEffect(() => { if (!actions.getState().data.conversations[conversationId]?.deletedAt) void resumeNativeRuns(); }, [conversationId]);
  const source = conversation?.inlineSource;
  const operation = source?.operation ?? (initialAction === 'translation' || initialAction === 'summary' ? initialAction : 'question');
  const operationLabel = operation === 'translation' ? '翻译' : operation === 'summary' ? '摘要卡片' : '提问';
  const evidence = source && data.evidence[source.evidenceId];
  const hasAnnotation = evidence && (!evidence.contextOnly || evidence.annotationHidden || readerActivities(data, evidence.id).length > 0);
  let materials: ReturnType<typeof snapshotContext> = [], scopeProblem = '';
  if (conversation) {
    try { materials = snapshotContext(data, conversation.researchId, conversationId); }
    catch (error) { scopeProblem = error instanceof Error ? error.message : '来源暂不可用，请重新选择材料。'; }
  }
  const sourceIds = source?.evidenceIds ?? (source ? [source.evidenceId] : []);
  const onlyOriginal = materials.length === sourceIds.length && materials.every(item => sourceIds.includes(item.evidenceId));
  const sourcePages = sourceIds.flatMap(id => data.evidence[id] ? [data.evidence[id].pageIndex] : []);
  const requests = conversation?.requestIds.map(id => data.requests[id]).filter(request => request && !request.superseded && (!request.purpose || request.purpose === 'chat')) ?? [];
  const latest = requests.at(-1);
  const generating = requests.find(request => request.status === 'generating');
  const [preparing, setPreparing] = useState(false);
  const [supplementing, setSupplementing] = useState(false);
  const steering = useRef(false);
  const [problem, setProblem] = useState('');
  const [draftOpen, setDraftOpen] = useState(!!source?.draftId && operation === 'summary');
  const draft = source?.draftId ? data.cardDrafts[source.draftId] : undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const requestBusy = useRef(false);
  const followOutput = useRef(true);
  const busy = preparing || !!generating;
  const brief = latest ? latest.paperBrief : conversation?.paperBrief;
  const sharedBrief = source && data.documents[source.documentId]?.paperBrief;
  const autoPrompt = operation === 'translation'
    ? '请把本次选区中的原文完整翻译为准确、自然的中文，保留术语、公式和限定条件。仅翻译所选原文；不概括整篇论文，不引入其他段落或论文知识，不加入解释。译文末尾标明所用原文引用。'
    : operation === 'summary'
      ? '请把本次所选原文或区域整理为一张简洁、独立可读的摘要卡片。仅总结此选区，不能当作整篇论文摘要。第一行为简短标题，正文用中文保留关键观点、条件和限制，并标明本次原文引用；图像不清或无法确认时明确说明，不编造文字。'
      : '请用容易理解的中文解释这段原文的意思，再点出理解它所需的关键概念。区分原文结论和补充解释，回答简洁。';
  const close = () => onClose();
  async function ask(prompt: string, selectionOnly = false) {
    if (!conversation || actions.getState().data.conversations[conversationId]?.deletedAt || requestBusy.current || busy || !prompt.trim()) return;
    if (scopeProblem) { setProblem(scopeProblem); return; }
    requestBusy.current = true; setPreparing(true); setProblem('');
    try {
      const config = await inlineAIConfig(conversation.researchId, conversationId);
      if (actions.getState().data.conversations[conversationId]?.deletedAt) return;
      if (operation === 'translation' && !materials.some(item => item.quote.trim())) throw new Error('此区域没有可提取的原文，尚未进行 OCR。可以返回选择文字或对区域提问。');
      if (materials.some(item => item.kind === 'region') && !config.images) throw new Error('当前模型未开启图片理解。区域已保留，可改选文字，或在设置中配置支持图片的模型。');
      if (materials.filter(item => item.kind === 'region').length > config.limits.maxImages) throw new Error(`所选区域超过当前连接每次最多 ${config.limits.maxImages} 张图片的上限。选区已保留，可返回保存摘录或缩小选择。`);
      followOutput.current = true;
      await submitAI(conversation.researchId, conversationId, prompt, undefined,
        { board: 'none', readerOperation: operation, paperBrief: operation === 'question' && !selectionOnly ? 'auto' : 'none' });
    } catch (error) { setProblem(error instanceof Error ? error.message : '暂时无法回答，请重试。'); }
    finally { requestBusy.current = false; setPreparing(false); }
  }
  useEffect(() => {
    if (deleted) { started.current = true; return; }
    input.current?.focus();
    if (!started.current && (initialAction === 'explain' || operation !== 'question') && !requests.length) {
      started.current = true;
      void ask(autoPrompt);
    }
  }, [conversationId]);
  useEffect(() => {
    if (actions.getState().data.conversations[conversationId]?.deletedAt || operation !== 'summary' || latest?.status !== 'done' || latest.validationError) return;
    try {
      createInlineCardDraft(latest.id);
      setDraftOpen(true);
    } catch (error) { setProblem(error instanceof Error ? error.message : '卡片草稿暂时无法创建，回答已保留。'); }
  }, [operation, latest?.id, latest?.status]);
  useEffect(() => {
    const node = content.current;
    if (node && followOutput.current) node.scrollTop = node.scrollHeight;
  }, [latest?.body, latest?.nativeRun?.cursor, latest?.status, requests.length, problem]);
  if (!conversation || !source || !evidence) return <div className="inline-ai-missing"><p>这次提问的来源已不存在。</p><button className="button" onClick={close}>返回阅读</button></div>;
  // The capture handler persists typing before unrelated workspace updates render.
  const updateInput = (value: string) => {
    const current = actions.getState().data.conversations[conversationId];
    if (!current || current.deletedAt || current.input === value) return;
    actions.updateData(next => { if (next.conversations[conversationId]) next.conversations[conversationId].input = value; });
  };
  const run = (operation: () => void) => { setProblem(''); try { operation(); } catch (error) { setProblem(error instanceof Error ? error.message : '操作失败，内容已保留。'); } };
  const retry = async () => {
    if (deleted || !latest || requestBusy.current || busy || scopeProblem) return;
    requestBusy.current = true; setPreparing(true); setProblem('');
    try { await inlineAIConfig(conversation.researchId, conversationId); if (!actions.getState().data.conversations[conversationId]?.deletedAt) await retryAI(latest.id); }
    catch (error) { setProblem(error instanceof Error ? error.message : '重试失败，请稍后再试。'); }
    finally { requestBusy.current = false; setPreparing(false); }
  };
  const canSupplement = !deleted && generating?.nativeRun?.transport === 'connected' && !!generating.nativeTurnId
    && ['running', 'compacting'].includes(generating.nativeRun.state) && !generating.nativeRun.pendingSteer;
  const supplement = async () => {
    if (actions.getState().data.conversations[conversationId]?.deletedAt || !generating || !canSupplement || steering.current) return;
    steering.current = true; setSupplementing(true); setProblem('');
    try { await steerNativeRun(generating.id, conversation.input ?? ''); }
    catch (error) { setProblem(error instanceof Error ? error.message : '补充尚未确认，草稿已保留。'); }
    finally { steering.current = false; setSupplementing(false); }
  };
  const updateDraft = (field: 'title' | 'body', value: string) => actions.updateData(next => {
    const current = source.draftId && next.cardDrafts[source.draftId];
    if (!next.conversations[conversationId]?.deletedAt && current && current.status !== 'saved') { current[field] = value; current.revision++; current.status = 'editing'; }
  });
  return <section className="inline-ai-dialog" role="dialog" aria-label={`原文旁${operationLabel}`} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  }}>
    <header className="inline-ai-header" data-popover-drag>
      {draftOpen && <button className="icon-button" aria-label="返回就地问答并保留卡片草稿" onClick={() => setDraftOpen(false)}><ArrowLeft size={15} /></button>}
      <button type="button" className="inline-ai-move" data-popover-move aria-label="移动原文旁问答" title={`${operationLabel} · ${conversation.title?.trim() || '原文旁提问'} · 拖动标题栏移动`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"><GripHorizontal size={14} /><strong>{draftOpen ? draft?.status === 'saved' ? '卡片已保存' : operation === 'summary' ? '摘要卡片' : '整理为卡片' : conversation.titleEdited && conversation.title?.trim() || operationLabel}</strong></button>
      <span>{pageRangeLabel(sourcePages)}</span>
      <RenameConversationButton conversationId={conversationId}/>
      <button className="icon-button" aria-label="关闭就地问答并保留内容" title="收起，内容会保留 · Esc" onClick={close}><X size={15} /></button>
    </header>
    {deleted && <div className="inline-ai-deleted" role="status"><span>会话已删除，此处记录仅供查看。提问与草稿仍保留。</span><button className="text-button" onClick={() => run(() => actions.restoreDeletedConversation(conversationId))}>恢复会话</button></div>}
    <div className="inline-ai-source-row">
      <details className="inline-ai-source"><summary>{scopeProblem ? '材料暂不可用' : onlyOriginal ? `所选${evidence.kind === 'region' ? '区域' : '原文'}${sourceIds.length > 1 ? ` · ${sourceIds.length} 个片段` : ''}` : `本轮原文 · ${materials.length}`}<span>查看来源</span></summary><div className="inline-ai-materials">{scopeProblem ? <p role="alert">{scopeProblem}</p> : materials.map(item => <div key={item.evidenceId}>{(!onlyOriginal || sourceIds.length > 1) && <button type="button" className="text-button" onClick={() => onSource(item.evidenceId)}>{item.title} · PDF 第 {item.pageIndex + 1} 页 · 定位原文</button>}<blockquote>{item.quote || `PDF 第 ${item.pageIndex + 1} 页的框选区域`}</blockquote></div>)}</div></details>
      {hasAnnotation && <button className="text-button inline-ai-mark-toggle" title="仅改变原文标记，保留提问、摘录、卡片与引用" onClick={() => run(() => onMarkChange(evidence.id, !!evidence.annotationHidden))}>{evidence.annotationHidden ? '恢复标记' : '移除标记'}</button>}
    </div>
    {operation === 'question' && <div className="inline-ai-brief-row">
      {brief ? <details className="inline-ai-brief"><summary>文章简要 v{brief.version}<span>覆盖 {brief.pageIndices.length}/{brief.totalPages} 页</span></summary>
        <div><p>仅作背景，引用仍以原文选区为准。已覆盖 PDF 页：{brief.pageIndices.map(index => index + 1).join('、') || '无'}{brief.truncatedPageIndices.length ? `；其中 ${brief.truncatedPageIndices.map(index => index + 1).join('、')} 页文字不完整` : ''}。</p><MarkdownContent text={brief.body} /></div>
      </details> : <span>{generating?.paperBriefState === 'preparing' || sharedBrief?.status === 'preparing' ? '正在生成本篇文章简要…' : generating?.paperBriefState === 'selection-only' || latest?.paperBriefState === 'selection-only' ? '本轮仅使用选区' : latest?.paperBriefState === 'error' || sharedBrief?.status === 'error' ? '文章简要暂不可用 · 本轮仅使用选区' : '首次提问时生成文章简要'}</span>}
      {!deleted && generating?.paperBriefState === 'preparing' && <button type="button" className="text-button" onClick={() => run(() => skipPaperBrief(generating.id))}>先只问选区</button>}
    </div>}
    {draftOpen && draft ? <>
      <div className="inline-ai-draft">
        {draft.status === 'saved' ? <><h3>{draft.title}</h3><MarkdownContent text={draft.body} onCitation={number => draft.evidenceIds[number - 1] && onSource(draft.evidenceIds[number - 1])} /><p className="inline-ai-saved" role="status"><Check size={13} />{saveStatus === 'error' ? '本地保存失败，草稿仍保留' : '已加入当前研究的卡片，原文和问答来源一并保留。'}{saveStatus === 'error' && <button className="text-button" onClick={() => actions.retrySave()}>重试保存</button>}</p></> : <>
          <label>标题<input aria-label="就地卡片标题" readOnly={deleted} value={draft.title} maxLength={200} onChange={event => updateDraft('title', event.target.value)} /></label>
          <label>正文<textarea aria-label="就地卡片正文" readOnly={deleted} value={draft.body} onChange={event => updateDraft('body', event.target.value)} /></label>
          <label className="inline-ai-review"><input type="checkbox" disabled={deleted} checked={draft.needsReview} onChange={event => actions.updateData(next => { if (!next.conversations[conversationId]?.deletedAt) next.cardDrafts[draft.id].needsReview = event.target.checked; })} />待核查</label>
        </>}
      </div>
      {draft.status !== 'saved' && <div className="inline-ai-draft-footer"><span>{deleted ? '草稿已保留，恢复会话后可继续编辑' : '编辑确认后保存 · 保留原文与问答来源'}</span>{!deleted && <button className="primary" disabled={!draft.title.trim() || !draft.body.trim()} onClick={() => run(() => { commitCardDraft(draft.id); })}>保存卡片</button>}</div>}
    </> : <>
      <div ref={content} className="inline-ai-content" onScroll={event => { const node = event.currentTarget; followOutput.current = node.scrollHeight - node.scrollTop - node.clientHeight < 50; }}>
        {!requests.length && !busy && <p className="inline-ai-empty">{deleted ? '这里还没有已发送的回答。' : operation === 'question' ? '这段哪里不明白？可以直接问。' : <>准备{operationLabel}所选原文。<button className="text-button" onClick={() => void ask(autoPrompt)}>开始{operationLabel}</button></>}</p>}
        {requests.map((request, index) => <article className="inline-ai-turn" key={request.id}>
          <p className="inline-ai-question">{index === 0 && operation !== 'question' ? operation === 'translation' ? '翻译所选原文' : '整理选区摘要卡片' : index === 0 && initialAction === 'explain' && request.prompt.startsWith('请用容易理解') ? '解释这段' : request.prompt}</p>
          <details className="inline-ai-turn-scope"><summary>当轮上下文</summary><p>{request.paperBrief ? `文章简要 v${request.paperBrief.version} · 覆盖 ${request.paperBrief.pageIndices.length}/${request.paperBrief.totalPages} 页；` : '未使用文章简要；'}原文 {request.context.length} 处；本会话历史 {request.historyRequestIds?.length ?? request.history?.length ?? 0} 轮。</p>
            {request.context.map(item => <blockquote key={item.evidenceId}>{item.title} · PDF 第 {item.pageIndex + 1} 页<br />{item.quote || '所选区域图片'}</blockquote>)}
            {request.paperBrief && <p className="inline-ai-turn-brief">{request.paperBrief.body}</p>}
          </details>
          {request.nativeRun ? <NativeRunTimeline request={request} onCitation={number => {
            const ids = request.status === 'done' ? request.evidenceIds : request.context.map(item => item.evidenceId);
            if (ids[number - 1]) onSource(ids[number - 1]);
          }} /> : request.body && <MarkdownContent text={request.body} onCitation={number => {
            const ids = request.status === 'done' ? request.evidenceIds : request.context.map(item => item.evidenceId);
            if (ids[number - 1]) onSource(ids[number - 1]);
          }} />}
          {!deleted && request.status === 'generating' && !request.nativeRun && <p className="inline-ai-working" role="status">{request.body ? '正在回答…' : '正在理解所选内容…'}</p>}
          {request.status !== 'done' && request.status !== 'generating' && <div className="inline-ai-request-error" role={request.status === 'stopped' ? 'status' : 'alert'}><span>{request.error || '回答未完成，已有内容已保留。'}</span>{!deleted && index === requests.length - 1 && <button className="text-button" disabled={busy} onClick={() => void retry()}>重试</button>}
            {!deleted && index === requests.length - 1 && request.paperBriefState === 'error' && <button className="text-button" disabled={busy} onClick={() => void ask(request.prompt, true)}>仅按选区重试</button>}
          </div>}
          {request.mode === 'demo' && <span className="inline-ai-demo">演示回答</span>}
        </article>)}
        {!deleted && preparing && !generating && !latest && <p className="inline-ai-working" role="status">正在连接阅读助手…</p>}
        {deleted && conversation.input && <div className="inline-ai-retained-input"><strong>未发送草稿</strong><p>{conversation.input}</p></div>}
      </div>
      <div className="inline-ai-answer-actions">
        {deleted ? draft && <button className="text-button" onClick={() => setDraftOpen(true)}><Layers size={13} />查看保留草稿</button> : <>
          {latest?.status === 'done' && !latest.validationError && <button className="text-button" onClick={() => run(() => { createInlineCardDraft(latest.id); setDraftOpen(true); })}><Layers size={13} />{draft?.source.requestId === latest.id ? draft.status === 'saved' ? '查看已存卡片' : '查看卡片草稿' : operation === 'translation' ? '另存翻译笔记' : '收为卡片'}</button>}
          <button className="text-button" onClick={() => run(() => { continueInlineInPanel(conversationId); close(); })}>在右侧继续<ChevronRight size={13} /></button>
        </>}
      </div>
      {!deleted && <form className="inline-ai-composer" onSubmit={event => { event.preventDefault(); void ask(conversation.input ?? ''); }}>
        <textarea ref={input} rows={2} aria-label="向原文旁助手提问" placeholder={requests.length ? '继续问这段原文…' : '这段是什么意思？'} value={conversation.input ?? ''} onInputCapture={event => updateInput(event.currentTarget.value)} onChange={event => updateInput(event.currentTarget.value)} onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(conversation.input ?? ''); }
        }} />
        {canSupplement && <button className="text-button" type="button" aria-label="补充就地本轮" disabled={supplementing || !conversation.input?.trim()} onClick={() => void supplement()}>补充本轮</button>}
        {busy ? <button className="inline-ai-send" type="button" aria-label="停止就地回答" disabled={!generating} onClick={event => { event.preventDefault(); if (generating) stopAI(generating.id); }}><Square size={13} /></button> : <button className="inline-ai-send" type="submit" aria-label="发送就地问题" disabled={!conversation.input?.trim() || !!scopeProblem}><ArrowUp size={16} /></button>}
      </form>}
    </>}
    {problem && <div className="inline-ai-problem" role="alert">{problem}{!deleted && !requests.length && (initialAction === 'explain' || operation !== 'question') && <button className="text-button" disabled={busy} onClick={() => void ask(autoPrompt)}>重试{operationLabel}</button>}</div>}
    <button type="button" className="inline-ai-resize" data-popover-resize aria-label="调整原文旁问答大小" title="拖动调整大小 · 方向键调整，Shift 加速" aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"><MoveDiagonal2 size={13} /></button>
  </section>;
}
