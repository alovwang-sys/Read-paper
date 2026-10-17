import { hasFullText, researchEvidence } from '../../domain/knowledge';
import { useWorkspace } from '../../services/workspace';

export function FindEvidencePanel({ cardId }: { cardId: string }) {
  const { data, research, actions } = useWorkspace();
  const card = data.cards[cardId];
  if (!card || !research) return <div className="empty-state compact">卡片或研究已缺失。</div>;
  const used = new Set(research.cardIds.flatMap(id => data.cards[id]?.evidenceIds ?? []));
  const excerpts = researchEvidence(data, research.id).filter(e => !e.dismissed).sort((a, b) => Number(used.has(a.id)) - Number(used.has(b.id)));
  return <section className="knowledge-panel" aria-label="找依据">
    <span className="section-heading">从论点回到原文</span><h3>为「{card.title}」找依据</h3><p className="muted">选择原文后，确认它是否确实支持这个观点。</p>
    <div className="button-row"><button className="button" onClick={() => actions.openResearchView(research.id, 'sources')}>去资料里找</button><button className="primary" onClick={() => {
      actions.updateData(next => { next.sessions[research.id].panel.findEvidenceFor = undefined; });
      actions.openResource({ kind: 'card', id: cardId }, { scope: data.scope, target: 'inspector' });
    }}>完成</button></div>
    {!excerpts.length && <p className="muted">本研究还没有可用摘录。打开资料选中原文，即可设为依据；无全文资料需先添加 PDF。</p>}
    {excerpts.map(e => <article className="excerpt-candidate" key={e.id}><strong>{data.documents[e.documentId]?.title}</strong><small className="muted">PDF 第 {e.pageIndex + 1} 页{used.has(e.id) ? ' · 已用于卡片' : ''}</small><blockquote>{e.quote || '区域摘录'}</blockquote><div className="button-row"><button className="button" disabled={card.evidenceIds.includes(e.id)} onClick={() => { try { actions.attachEvidenceToCard(cardId, e.id); } catch (error) { actions.notice((error as Error).message); } }}>{card.evidenceIds.includes(e.id) ? '已作为依据' : '作为依据'}</button><button className="text-button" onClick={() => actions.openResource({ kind: 'document', id: e.documentId }, { scope: data.scope, target: 'main', anchor: { evidenceId: e.id } })}>看原文 ↗</button></div></article>)}
  </section>;
}

export function TraceChain({ draftId, evidenceId }: { draftId: string; evidenceId: string }) {
  const { data, actions } = useWorkspace();
  const draft = data.drafts[draftId], evidence = data.evidence[evidenceId];
  const doc = evidence && data.documents[evidence.documentId];
  const cards = [...new Set((draft?.cardRefs ?? []).filter(ref => ref.evidenceIds?.includes(evidenceId) || data.cards[ref.cardId]?.evidenceIds.includes(evidenceId)).map(ref => ref.cardId))].map(id => data.cards[id]).filter(Boolean);
  return <section className="knowledge-panel trace-chain" aria-label="出处链">
    <div className="section-title"><h3>出处链</h3><button className="text-button" onClick={() => actions.updateData(next => { next.sessions[next.scope.kind === 'research' ? next.scope.researchId : 'library'].panel.citation = undefined; })}>关闭出处链</button></div>
    <article><span className="section-heading">文稿引用</span><strong>{draft?.title ?? '文稿已缺失'} {draft && `[${draft.evidenceIds.indexOf(evidenceId) + 1}]`}</strong></article>
    {cards.length ? cards.map(card => <article key={card.id}><span className="section-heading">插入的卡片 · {card.needsReview ? '待核查' : '已核查'}</span><strong>{card.title}</strong><p>{card.body}</p><button className="text-button" onClick={() => actions.openResource({ kind: 'card', id: card.id }, { scope: data.scope, target: 'main' })}>打开卡片</button>{!card.evidenceIds.length && <button className="button" onClick={() => actions.findEvidence(card.id)}>找依据</button>}</article>) : <p className="muted">这处引用未记录对应卡片，仍可核对下方原文。</p>}
    <article><span className="section-heading">摘录与原文</span><strong>{doc?.title ?? '来源文献已缺失'}</strong>{evidence && <small>PDF 第 {evidence.pageIndex + 1} 页{evidence.printedPage ? ` · 印刷页码 ${evidence.printedPage}` : ''}</small>}<blockquote>{evidence?.quote || (evidence?.kind === 'region' ? '保存的 PDF 框选区域，可打开原文核对。' : '原文摘录缺失，请检查文稿引用。')}</blockquote>{hasFullText(doc) && evidence ? <button className="primary" onClick={() => { try { actions.openResource({ kind: 'document', id: doc.id }, { scope: data.scope, target: 'main', anchor: { evidenceId } }); } catch (error) { actions.notice((error as Error).message); } }}>在主区打开原文 ↗</button> : <p className="writing-error">原 PDF 资产缺失，已保留可用的摘录内容。</p>}</article>
  </section>;
}
