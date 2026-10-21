import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, ExternalLink, FileText, MessageSquare, Plus, Search, Square } from 'lucide-react';
import type { LiteratureCandidate, LiteratureSearch } from '../../domain/types';
import { normalizeIdentifier } from '../../domain/knowledge';
import { useWorkspace } from '../../services/workspace';
import { candidateMaterial, focusLiteratureCandidate, importLiteratureCandidate, placeLiteratureCandidate, searchBoardLiterature, setResearchMaterial, stopLiteratureSearch } from '../../services/board-research';
import './board-literature.css';

const statusLabel: Record<LiteratureSearch['status'], string> = { searching: '检索中', done: '已完成', error: '失败', stopped: '已停止', interrupted: '已中断' };
function safeLink(value: string | undefined) {
  if (!value) return;
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch { /* Invalid saved links are not clickable. */ }
}

export function BoardLiterature({ conversationId }: { conversationId: string }) {
  const { data, actions } = useWorkspace();
  const [error, setError] = useState('');
  const scroll = useRef<HTMLDivElement>(null);
  const conversation = data.conversations[conversationId], state = conversation?.boardResearch;
  const research = conversation && data.researches[conversation.researchId];
  const batches = conversation?.literatureSearches ?? [];
  const batch = batches.find(item => item.id === state?.literatureBatchId) ?? batches.at(-1);
  const active = batches.find(item => item.status === 'searching');
  const query = state?.literatureQuery ?? '';
  useLayoutEffect(() => {
    setError('');
    if (scroll.current) scroll.current.scrollTop = state?.literatureScrollTop ?? 0;
  }, [conversationId, batch?.id]);
  if (!state || !research || data.scope.kind !== 'research' || data.scope.researchId !== research.id) return null;

  function execute(action: () => void) {
    try { action(); setError(''); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '操作失败，请重试。'); }
  }
  function start(value: string, filters = { yearFrom: state?.literatureYearFrom, yearTo: state?.literatureYearTo }) {
    setError('');
    void searchBoardLiterature(conversationId, value, filters).catch(caught => setError(caught instanceof Error ? caught.message : '检索未能开始，请重试。'));
  }
  function suggestQuery(value: string) {
    if (value.length > 500) { setError('加入建议后超过 500 字符，请先缩短检索词。'); return; }
    actions.updateData(next => { const current = next.conversations[conversationId]?.boardResearch; if (current) current.literatureQuery = value; });
    setError('');
  }
  function setYear(field: 'literatureYearFrom' | 'literatureYearTo', value: string) {
    if (value && !/^[1-9]\d{0,3}$/.test(value)) { setError('年份须为 1–9999 的整数；留空表示不限。'); return; }
    actions.updateData(next => { const current = next.conversations[conversationId]?.boardResearch; if (current) current[field] = value ? Number(value) : undefined; });
    setError('');
  }
  function existingDocument(candidate: LiteratureCandidate) {
    const doi = candidate.doi ? normalizeIdentifier(candidate.doi) : undefined;
    return (candidate.documentId && data.documents[candidate.documentId]) || Object.values(data.documents).find(doc =>
      doc.discovery?.providerId === candidate.providerId || doi?.kind === 'doi' && doc.identifiers?.doi && normalizeIdentifier(doc.identifiers.doi)?.value === doi.value);
  }
  function returnToChat() {
    actions.updateData(next => { const current = next.conversations[conversationId]?.boardResearch; if (current) current.view = 'chat'; });
  }
  const anchor = batch?.rootPlacementId ? data.placements[batch.rootPlacementId] : undefined;
  const canPlace = !!batch && !!anchor && anchor.boardId === batch.boardId;
  const paperFocus = state.automatic.find(item => item.kind === 'abstract');

  return <section className="board-literature" aria-label="白板问题找文献">
    <header className="board-literature-header">
      <button type="button" className="text-button" onClick={returnToChat}><ArrowLeft size={15} />返回讨论</button>
      <span><Search size={14} />找文献</span>
    </header>
    <div className="board-literature-origin"><small>围绕这个问题</small><strong>{state.origin.rootTitle}</strong></div>
    <form className="board-literature-form" onSubmit={event => { event.preventDefault(); start(query); }}>
      <label htmlFor={`literature-query-${conversationId}`}>检索词</label>
      <div className="board-literature-query-row"><input id={`literature-query-${conversationId}`} type="search" maxLength={500} value={query} placeholder="输入论文关键词，英文关键词通常覆盖更广" onChange={event => actions.updateData(next => { const current = next.conversations[conversationId]?.boardResearch; if (current) current.literatureQuery = event.target.value; })} />
        <button className="primary" type="submit" disabled={!query.trim() || !!active}><Search size={14} />检索</button></div>
      <div className="board-literature-filters"><span>年份</span><input type="text" inputMode="numeric" maxLength={4} aria-label="起始年份" placeholder="不限" value={state.literatureYearFrom ?? ''} onChange={event => setYear('literatureYearFrom', event.target.value)} /><span>至</span><input type="text" inputMode="numeric" maxLength={4} aria-label="截止年份" placeholder="不限" value={state.literatureYearTo ?? ''} onChange={event => setYear('literatureYearTo', event.target.value)} /></div>
      <div className="board-literature-suggestions"><span>修改检索词</span><button type="button" className="text-button" onClick={() => suggestQuery(`${query.trim()}${query.trim() ? ' ' : ''}(limitations OR failure OR "negative results")`)}>核查限制/反例</button><button type="button" className="text-button" disabled={!paperFocus} title={paperFocus?.title ?? '先在候选文献中选择“讨论这篇”。'} onClick={() => { if (paperFocus) suggestQuery(paperFocus.title); }}>以当前论文继续找</button></div>
      <p>仅发送检索词与年份至 OpenAlex，首批最多 10 条。检索排序和摘要不能证明支持或反驳；建议只改词，不自动发送。</p>
    </form>
    {!!batches.length && <label className="board-literature-batches">检索记录<select aria-label="查看检索批次" value={batch?.id ?? ''} onChange={event => actions.updateData(next => {
      const current = next.conversations[conversationId]?.boardResearch;
      if (current) { current.literatureBatchId = event.target.value; current.literatureScrollTop = 0; }
    })}>{batches.map((item, index) => <option key={item.id} value={item.id}>第 {index + 1} 轮 · {statusLabel[item.status]} · {item.query.slice(0, 45)}</option>)}</select></label>}
    {active && <div className="board-literature-progress" role="status"><span>正在检索{active.id !== batch?.id ? '另一轮查询' : ''}…</span><button type="button" className="text-button" onClick={() => stopLiteratureSearch(active.id)}><Square size={12} />停止检索</button></div>}
    {error && <p className="board-literature-error" role="alert">{error}</p>}
    <div className="board-literature-scroll" ref={scroll} onScroll={event => {
      const top = event.currentTarget.scrollTop;
      actions.updateData(next => { const current = next.conversations[conversationId]?.boardResearch; if (current) current.literatureScrollTop = top; });
    }}>
      {!batch && <div className="board-literature-empty"><BookOpen size={25} /><h3>从这一点继续找依据</h3><p>调整关键词后检索。查看来源、选择收录，也可以先把候选加入讨论。</p></div>}
      {batch && <>
        <div className="board-literature-batch-summary"><strong>{batch.query}</strong><span>{new Date(batch.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {statusLabel[batch.status]}{batch.status === 'done' ? ` · ${batch.candidates.length} 篇` : ''}{batch.yearFrom !== undefined || batch.yearTo !== undefined ? ` · ${batch.yearFrom ?? '不限'}–${batch.yearTo ?? '不限'} 年` : ''}</span></div>
        {(batch.status === 'error' || batch.status === 'stopped' || batch.status === 'interrupted') && <div className={batch.status === 'error' ? 'board-literature-error' : 'board-literature-notice'} role="status"><p>{batch.error || (batch.status === 'interrupted' ? '上次检索已中断，原查询仍保留。' : '检索已停止，之前的检索记录仍保留。')}</p><button type="button" className="text-button" disabled={!!active} onClick={() => start(batch.query, { yearFrom: batch.yearFrom, yearTo: batch.yearTo })}>用原查询重试</button></div>}
        {!!batch.warnings?.length && <div className="board-literature-notice" role="status">{batch.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
        {batch.status === 'done' && !batch.candidates.length && <div className="board-literature-empty"><Search size={24} /><h3>没有找到文献</h3><p>试试更短的关键词、英文术语，或换一种表述再检索。</p></div>}
        {batch.candidates.map(candidate => {
          const document = existingDocument(candidate);
          const linked = !!document && research.documentIds.includes(document.id);
          const pinned = state.pinned.some(item => item.id === candidate.id) && !state.excludedSourceIds.includes(candidate.id);
          const placed = !!document && Object.values(data.placements).some(item => item.boardId === batch.boardId && item.researchConversationId === conversationId && item.resourceRef.kind === 'document' && item.resourceRef.id === document.id);
          const url = safeLink(candidate.url), pdf = safeLink(candidate.pdfUrl);
          return <article className="board-literature-candidate" key={candidate.id}>
            <div className="board-literature-candidate-meta"><span className={linked ? 'is-linked' : ''}>{linked ? <Check size={12} /> : <FileText size={12} />}{linked ? '已关联本研究' : document ? '已在资料库' : '新发现'}</span><small>{candidate.year ?? '年份未提供'} · {candidate.abstract ? '有来源摘要' : '仅有题录'}</small></div>
            <h3>{candidate.title}</h3>
            <p className="board-literature-authors">{candidate.authors.length ? candidate.authors.join(', ') : '来源未提供作者'}</p>
            <details><summary>摘要与来源</summary><div className="board-literature-source">
              <h4>OpenAlex 提供的摘要</h4><p className="board-literature-abstract">{candidate.abstract || '来源未提供摘要。当前仅可讨论题录，尚未读取论文原文。'}</p>
              {candidate.abstract && <p className="board-literature-source-note">来源文本可能不完整；尚未读取 PDF 原文。</p>}
              <dl><dt>DOI</dt><dd>{candidate.doi || '未提供'}</dd><dt>来源 ID</dt><dd>{candidate.providerId}</dd><dt>检索时间</dt><dd>{new Date(candidate.retrievedAt).toLocaleString('zh-CN')}</dd></dl>
              <div className="board-literature-links">{url && <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />查看来源</a>}{pdf && <a href={pdf} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />公开 PDF 链接</a>}</div>
              {pdf && <p className="board-literature-source-note">PDF 链接来自 OpenAlex，文件尚未获取。</p>}
            </div></details>
            <div className="board-literature-actions">
              <button type="button" className="text-button" onClick={() => execute(() => focusLiteratureCandidate(conversationId, candidate))}><MessageSquare size={13} />讨论这篇</button>
              <button type="button" className="text-button" disabled={pinned} onClick={() => execute(() => { setResearchMaterial(conversationId, candidateMaterial(candidate), true); actions.notice('已保留到后续讨论，尚未发送。'); })}><Plus size={13} />{pinned ? '已加入讨论' : '加入讨论'}</button>
              <button type="button" className="button" disabled={linked} onClick={() => execute(() => { importLiteratureCandidate(conversationId, batch.id, candidate.id); actions.notice('文献已收录并关联本研究。'); })}>{linked ? '已收录' : document ? '关联本研究' : '加入资料库'}</button>
              <button type="button" className="button" disabled={!linked || !canPlace || placed} title={!linked ? '先收录并关联本研究，再选择放到白板。' : !canPlace ? '原问题位置已缺失，检索结果仍保留。' : undefined} onClick={() => execute(() => { placeLiteratureCandidate(conversationId, batch.id, candidate.id); actions.notice('已放回原问题旁，关系待核查。'); })}>{placed ? '已放到白板' : '放回问题旁'}</button>
            </div>
            {document && <button type="button" className="text-button board-literature-open" onClick={() => execute(() => actions.openResource({ kind: 'document', id: document.id }, { scope: linked ? { kind: 'research', researchId: research.id } : { kind: 'library' }, target: 'main' }))}>打开文献详情与补全文<ExternalLink size={12} /></button>}
          </article>;
        })}
        {!!batch.candidates.length && !canPlace && <p className="board-literature-notice">原问题位置已缺失，暂不能放回白板；结果仍可收录和讨论。</p>}
      </>}
    </div>
  </section>;
}
