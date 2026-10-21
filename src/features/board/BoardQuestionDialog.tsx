import { useEffect, useId, useRef, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { createBoardQuestion, openBoardResearch } from '../../services/board-research';
import { useWorkspace } from '../../services/workspace';
import { drawingQuestionTooLarge, questionPositionNear } from './board-research-selection';
import './research-actions.css';

export type DrawingQuestionSource = { elementIds: string[]; text: string };

export function BoardQuestionDialog({ boardId, open, onClose, position, drawingOrigin, onCreated }: {
  boardId: string;
  open: boolean;
  onClose: () => void;
  position?: { x: number; y: number };
  drawingOrigin?: DrawingQuestionSource;
  onCreated?: (placementId: string) => void;
}) {
  const { data, actions } = useWorkspace();
  const board = data.boards[boardId];
  const draft = data.sessions[board?.researchId ?? '']?.boardQuestionDrafts?.[boardId] ?? { title: '', body: '' };
  const [error, setError] = useState('');
  const [originApplied, setOriginApplied] = useState(false);
  const appliedSource = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const sourceKey = JSON.stringify(drawingOrigin ?? null);
  const sourceTooLarge = !!drawingOrigin && drawingQuestionTooLarge(drawingOrigin);

  function store(next: { title: string; body: string; drawingOrigin?: DrawingQuestionSource }) {
    if (next.title.length > 160 || next.body.length > 20000) { setError('标题最多 160 字符，问题描述最多 20,000 字符。已有草稿已保留。'); return; }
    actions.updateData(current => {
      const researchId = current.boards[boardId]?.researchId;
      if (!researchId || !current.sessions[researchId]) throw new Error('白板已不在当前研究中。');
      const drafts = current.sessions[researchId].boardQuestionDrafts ??= {};
      drafts[boardId] = { ...drafts[boardId], ...next };
    });
  }
  function useText() {
    if (!drawingOrigin || sourceTooLarge) return;
    store({ title: drawingOrigin.text.split('\n').find(line => line.trim())?.slice(0, 120) ?? '新的研究问题', body: drawingOrigin.text, drawingOrigin });
    appliedSource.current = sourceKey;
    setOriginApplied(true);
  }
  useEffect(() => {
    if (!open) { dialog.current?.close(); return; }
    opener.current = document.activeElement as HTMLElement;
    setError('');
    if (drawingOrigin && appliedSource.current !== sourceKey) {
      setOriginApplied(false);
      if (!sourceTooLarge && !draft.title.trim() && !draft.body.trim()) useText();
    }
    dialog.current?.showModal();
    title.current?.focus();
  }, [open, sourceKey, boardId]);

  function save(ask: boolean) {
    if (!draft.title.trim()) { setError('请写下问题标题。'); title.current?.focus(); return; }
    if (draft.title.length > 160 || draft.body.length > 20000) { setError('请将标题缩短到 160 字符、问题描述缩短到 20,000 字符以内。'); return; }
    let created: { cardId: string; placementId: string };
    try {
      const available = position ? questionPositionNear(position, Object.values(data.placements).filter(item => item.boardId === boardId)) : undefined;
      created = createBoardQuestion({ boardId, title: draft.title.trim(), body: draft.body, position: available, drawingOrigin: originApplied && drawingOrigin ? drawingOrigin : draft.drawingOrigin });
      appliedSource.current = ''; setOriginApplied(false);
      onCreated?.(created.placementId);
      onClose();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '问题未能保存，输入已保留，请重试。'); return; }
    if (ask) {
      try { openBoardResearch({ boardId, placementIds: [created.placementId], mode: 'ask' }); }
      catch (caught) { actions.notice(`问题已添加到白板，对话暂未打开：${caught instanceof Error ? caught.message : '请从问题卡片重试。'}`); }
    } else actions.notice('问题已添加到白板，可继续写卡片、问 Agent 或找文献。');
  }

  return <dialog ref={dialog} className="board-research-dialog board-question-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => opener.current?.focus()} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
    <form onSubmit={event => { event.preventDefault(); save(false); }}>
      <header><h2 id={titleId}>{drawingOrigin ? '把所选文字作为问题' : '写一个研究问题'}</h2><button type="button" className="icon-button" aria-label="关闭问题编辑" onClick={onClose}><X size={17} /></button></header>
      <div className="board-question-fields">
        {!drawingOrigin && draft.drawingOrigin && <p className="muted">此草稿保留此前绘图文字来源。</p>}
        {drawingOrigin && <details open className="board-question-source"><summary>核对选中的绘图文字 · {drawingOrigin.elementIds.length} 个元素</summary><pre>{drawingOrigin.text.length > 4000 ? `${drawingOrigin.text.slice(0, 4000)}\n\n（预览仅显示前 4,000 字符；完整来源尚未保存或附送。）` : drawingOrigin.text}</pre><p>保留原文字，只新增一张共享问题卡。图片与手写笔迹没有被识别为文字。</p>{sourceTooLarge ? <p role="alert">所选文字超过 20,000 字符或 1,000 个文字元素，不能直接转为问题。请缩小选区，或在下方手写简述；不会截断并保存来源。</p> : !originApplied && <><p>已有未完成草稿，内容已保留。使用所选文字会替换下面的标题与正文。</p><button type="button" className="button" onClick={useText}>使用所选文字</button></>}</details>}
        <label>问题标题<input ref={title} className="field" aria-label="研究问题标题" maxLength={160} value={draft.title} onChange={event => store({ ...draft, title: event.target.value })} placeholder="你想弄清哪一个小问题？" /></label>
        <label>想法与问题描述<textarea className="field" aria-label="研究问题描述" maxLength={20000} value={draft.body} onChange={event => store({ ...draft, body: event.target.value })} placeholder="你已经知道什么？还需要核查什么？" /></label>
        <p className="muted">输入随研究保存，关闭后可继续编辑。卡片正文独立保存，不自动附送关联原文或发送请求。</p>
        {error && <p className="board-research-inline-error" role="alert">{error}</p>}
      </div>
      <footer><button type="button" className="button" onClick={onClose}>稍后继续</button><button type="button" className="button" disabled={!draft.title.trim()} onClick={() => save(true)}><MessageSquare size={14} />添加并问 Agent</button><button type="submit" className="button primary" disabled={!draft.title.trim()}>添加到白板</button></footer>
    </form>
  </dialog>;
}
