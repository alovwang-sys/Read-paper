import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { AIRequest, Conversation, ResearchMaterial } from '../../domain/types';
import { buildRequestScope, historyForConversation } from '../../services/ai';
import { branchBoardResearch, findResearchEvidence, researchMaterials, returnToResearchRoot, setResearchMaterial } from '../../services/board-research';
import { useWorkspace } from '../../services/workspace';
import { ContextDetails } from './SourceDetails';
import './board-research-context.css';

const kindLabel = { background: '研究背景', card_note: '卡片正文', abstract: '题录与来源摘要' };
export function ResearchMaterialDetails({ items }: { items: ResearchMaterial[] }) {
  return <>{items.map(item => <details className="ai-details" key={item.id}>
    <summary>{item.title} · {kindLabel[item.kind]}</summary>
    <p className="ai-footnote">{item.kind === 'abstract' ? '来源提供的元信息或摘要，尚未核对 PDF 原文。' : item.kind === 'card_note' ? '研究者笔记或 AI 草稿，不等同于原文证据。' : '提供方向，不作为论文证据。'}</p>
    <blockquote className="br-source-text">{item.text}</blockquote>
    <p className="ai-footnote">来源 ID：{item.id} · 内容版本：{item.version}{item.retrievedAt ? ` · 获取时间：${item.retrievedAt}` : ''}</p>
    {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer">打开来源</a>}
    {item.derivedFrom && <p className="ai-footnote">AI 派生内容 · 待核查 · 来源：{item.derivedFrom.sourceIds.join('、') || '对话'}；轮次：{item.derivedFrom.requestIds.join('、')}</p>}
  </details>)}</>;
}
export function BoardResearchHeading({ conversation }: { conversation: Conversation }) {
  const { data, actions } = useWorkspace();
  const state = conversation.boardResearch;
  if (!state) return null;
  const focus = state.automatic.map(item => item.title).join('、') || state.origin.rootTitle;
  return <div className="br-origin">
    <div><span>原问题</span><strong title={state.origin.rootTitle}>{state.origin.rootTitle}</strong></div>
    <button className="text-button" onClick={() => {
      try {
        returnToResearchRoot(conversation.id);
        if (data.boards[state.origin.boardId]) actions.openResource({ kind: 'board', id: state.origin.boardId }, { scope: { kind: 'research', researchId: conversation.researchId }, target: 'main', anchor: { placementId: state.origin.rootPlacementId } });
      } catch (error) { actions.notice(error instanceof Error ? error.message : '原问题暂不可用。'); }
    }}>回到原问题</button>
    <small title={focus}>当前焦点：{focus}</small>
    <button className="text-button" onClick={() => actions.updateData(next => { next.conversations[conversation.id].boardResearch!.view = 'literature'; })}><Search size={12} />找文献</button>
  </div>;
}
export function BoardResearchControls({ conversation, disabled }: { conversation: Conversation; disabled?: boolean }) {
  const { data, actions } = useWorkspace();
  const [view, setView] = useState<'materials' | 'history' | 'evidence' | 'branch'>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [lookupScope, setLookupScope] = useState<'selected' | 'board' | 'research'>('selected');
  const [lookupId, setLookupId] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const state = conversation.boardResearch!;
  const selectedHistory = historyForConversation(data, conversation.id);
  let scope: ReturnType<typeof buildRequestScope> | undefined, scopeError = '';
  try { scope = buildRequestScope(data, conversation.researchId, conversation.id); } catch (caught) { scopeError = caught instanceof Error ? caught.message : '材料暂不可用。'; }
  let options: ResearchMaterial[] = [];
  try {
    const preview = structuredClone(data);
    const next = preview.conversations[conversation.id].boardResearch!;
    next.includeBackground = true; next.excludedSourceIds = [];
    options = researchMaterials(preview, conversation.id);
  } catch { /* Invalid current resources are reported by the shared request builder. */ }
  const included = new Set(scope?.materials.map(item => item.id) ?? []);
  const complete = conversation.requestIds.map(id => data.requests[id]).filter(item => item && (!item.purpose || item.purpose === 'chat') && item.status === 'done' && !item.validationError && !item.superseded && !item.legacy);
  const lookup = conversation.evidenceSearches?.find(item => item.id === lookupId) ?? conversation.evidenceSearches?.at(-1);
  const chars = scope ? JSON.stringify({ prompt: conversation.input ?? '', ...scope }).length : undefined;
  useEffect(() => { if (view) dialog.current?.showModal(); else dialog.current?.close(); }, [view]);
  const run = (action: () => unknown) => { try { action(); setError(''); } catch (caught) { setError(caught instanceof Error ? caught.message : '操作失败，内容已保留。'); } };
  const open = (next: NonNullable<typeof view>, button: HTMLButtonElement) => { trigger.current = button; setError(''); setView(next); };
  function removeEvidence(id: string) {
    actions.updateData(next => {
      const c = next.conversations[conversation.id];
      c.contextIds = c.contextIds.filter(eid => eid !== id);
      c.boardResearch!.excludedSourceIds = [...new Set([...c.boardResearch!.excludedSourceIds, `evidence:${id}`])];
    });
  }
  return <>
    <div className="br-controls">
      <button type="button" disabled={disabled} onClick={event => open('materials', event.currentTarget)}>材料 {(scope?.materials.length ?? 0) + (scope?.context.length ?? 0)} ▾</button>
      <button type="button" disabled={disabled} onClick={event => open('history', event.currentTarget)}>历史 {selectedHistory.length} 轮 ▾</button>
      <button type="button" disabled={disabled} onClick={event => open('evidence', event.currentTarget)}>找已有依据 ▾</button>
      <small title="包括问题、附送材料、所选历史与标识；不含供应商系统提示。模型剩余容量未知。">{chars === undefined ? '材料待修复' : `${chars.toLocaleString()} 字符估计 · 非 token`}</small>
    </div>
    <dialog ref={dialog} className="br-context-dialog" aria-labelledby="br-context-title" onCancel={event => { event.preventDefault(); setView(undefined); }} onClose={() => { setView(undefined); trigger.current?.focus(); }}>
      <header><h3 id="br-context-title">{view === 'history' ? '下一轮带哪些历史' : view === 'evidence' ? '找已有依据' : view === 'branch' ? '核对新分支材料' : '核对下一轮材料'}</h3><button type="button" className="icon-button" aria-label="关闭上下文核对" onClick={() => setView(undefined)}><X size={17} /></button></header>
      <div className="br-context-body">
        {(view === 'materials' || view === 'branch') && <>
          <p>下面的正文才会附送。研究、白板和原问题名称保留作定位；摘要与卡片不生成 PDF 引用编号。</p>
          {options.map(item => <article className="br-material-option" key={item.id}>
            <label><input type="checkbox" disabled={disabled} checked={included.has(item.id)} onChange={event => run(() => setResearchMaterial(conversation.id, item, event.target.checked, state.pinned.some(p => p.id === item.id)))} /><strong>{item.title}</strong></label>
            <small>{kindLabel[item.kind]} · {included.has(item.id) ? state.pinned.some(p => p.id === item.id) ? '主动保留' : item.kind === 'background' ? '背景' : '自动焦点' : '未附送'}</small>
            <ResearchMaterialDetails items={[item]} />
            {item.kind !== 'background' && !state.pinned.some(p => p.id === item.id) && <button type="button" className="text-button" onClick={() => run(() => setResearchMaterial(conversation.id, item, true))}>切焦点时仍保留</button>}
            {item.derivedFrom?.sourceIds.some(id => state.excludedSourceIds.includes(id)) && <p role="status" className="br-residual">已取消的来源仍可能出现在这张 AI 派生卡中。继续附送会保留其转述。</p>}
          </article>)}
          {(scope?.context ?? []).map(item => <article className="br-material-option" key={item.evidenceId}><strong>{item.title} · PDF 第 {item.pageIndex + 1} 页</strong><ContextDetails items={[item]} /><button type="button" className="text-button" onClick={() => run(() => removeEvidence(item.evidenceId))}>停止附送这条原文</button></article>)}
          <p className="ai-footnote">取消材料会过滤直接附件和历史原文快照；旧回答、背景及派生卡仍可能转述其内容。</p>
          {view === 'branch' ? <><p>新分支只带上方核对后的材料与当前输入，不继承旧助手消息。原生助手仍可能读到研究目录中的旧文件。</p><button type="button" className="button" disabled={!!scopeError} onClick={() => run(() => { branchBoardResearch(conversation.id); setView(undefined); })}>使用这些材料建立新分支</button></> : <button type="button" className="text-button" onClick={() => setView('branch')}>以当前材料另开分支…</button>}
        </>}
        {view === 'history' && <>
          <p>默认带上一完成轮与最近一次原问题讨论，去重后最多两轮。它是初始策略，仍需真实任务验证；完整聊天一直保留。</p>
          <label className="br-range-label">历史范围<select aria-label="白板讨论历史范围" value={conversation.historyRange ?? 'guided'} onChange={event => actions.updateData(next => { next.conversations[conversation.id].historyRange = event.target.value as Conversation['historyRange']; })}><option value="guided">上一轮＋最近原问题轮</option><option value="all">全部完成轮次</option><option value="latest">最近一轮</option><option value="none">不带历史</option><option value="selected">逐轮选择</option></select></label>
          {complete.map((request, index) => <article className="br-material-option" key={request.id}><label><input type="checkbox" checked={selectedHistory.some(item => item.requestId === request.id)} onChange={event => actions.updateData(next => { const c = next.conversations[conversation.id]; c.historyRange = 'selected'; const ids = selectedHistory.map(item => item.requestId); c.historyRequestIds = event.target.checked ? [...new Set([...ids, request.id])] : ids.filter(id => id !== request.id); })} />第 {index + 1} 轮 · {request.prompt}</label><details><summary>完整问答</summary><p className="br-source-text">{request.body}</p></details></article>)}
          {!complete.length && <p>还没有完成的问答。</p>}
          <p className="ai-footnote">历史消息仍可能转述已取消的材料。局部研究每次按清单建立原生运行，研究目录权限另行保留。</p>
        </>}
        {view === 'evidence' && <>
          <p>在已有卡片和摘录中按文字查找，结果先作为候选。此操作不会扩大普通问答的材料范围。</p>
          <form onSubmit={event => { event.preventDefault(); run(() => setLookupId(findResearchEvidence(conversation.id, lookupScope, query))); }}>
            <label className="br-range-label">查找集合<select aria-label="已有依据查找范围" value={lookupScope} onChange={event => setLookupScope(event.target.value as typeof lookupScope)}><option value="selected">已选材料</option><option value="board">当前白板</option><option value="research">本研究</option></select></label>
            <input aria-label="已有依据关键词" value={query} maxLength={500} placeholder="输入关键词，或留空浏览" onChange={event => setQuery(event.target.value)} />
            <button className="button" type="submit">查找已有依据</button>
          </form>
          {lookup && <><p>{lookup.candidates.length} 条候选 · 应用查过 {lookup.scannedIds.length} 项 · 查询“{lookup.query || '未限定'}”</p><details><summary>本次查找快照</summary><p>范围：{lookup.scope}；{lookup.createdAt}</p><p className="br-source-text">{lookup.scannedIds.join('\n')}</p><p>这是应用的本地文字查找记录，没有向模型附送这些候选。</p></details>
            {lookup.candidates.map(item => <article className="br-material-option" key={item.id}><strong>{item.title}</strong>{item.material && <ResearchMaterialDetails items={[item.material]} />}{item.evidence && <ContextDetails items={[item.evidence]} />}<button className="text-button" type="button" onClick={() => run(() => { if (item.material) setResearchMaterial(conversation.id, item.material, true); if (item.evidence) actions.addContext({ researchId: conversation.researchId, conversationId: conversation.id, evidenceIds: [item.evidence.evidenceId] }); actions.notice('已加入下一轮讨论。'); })}>加入讨论</button></article>)}
            {!lookup.candidates.length && <p>没有匹配项。可以调整范围或关键词，或通过“找文献”向外查找。</p>}</>}
        </>}
        {(error || scopeError) && <p role="alert" className="ai-error">{error || scopeError}</p>}
      </div>
      <footer><button type="button" className="button" onClick={() => setView(undefined)}>完成</button></footer>
    </dialog>
  </>;
}
export function ResearchRequestDetails({ request }: { request: AIRequest }) {
  return <>
    {request.boardResearch && <p className="ai-footnote">原问题：{request.boardResearch.rootTitle} · 白板 {request.boardResearch.boardId}</p>}
    <ResearchMaterialDetails items={request.materials ?? []} />
    {!!request.materials?.length && <p className="ai-footnote">以上为提交时冻结的正文与来源版本。后续修改不会改写此记录。</p>}
    {request.boardResearch && <p className="ai-footnote">应用附送清单如上；原生工具的实际文件读取另见运行记录，记录可能不完整。</p>}
  </>;
}
