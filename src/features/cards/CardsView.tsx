import { useState } from 'react';
import { Plus } from 'lucide-react';
import { usePaneViewState, useWorkspace } from '../../services/workspace';
import { researchResourceIds } from '../../domain/research-order';
import { ResourceOrderControls, useResearchResourceOrder } from '../../ui/ResourceOrderControls';
import { ResourceOpenMenu } from '../library/ResourceOpenMenu';
import './card-order.css';

export function CardsView({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const [filter, setFilter] = usePaneViewState<string>('filter', 'all');
  const [query, setQuery] = usePaneViewState<string>('query', '');
  const [picker, setPicker] = useState(false);
  const ids = researchResourceIds(data, researchId, 'card');
  const canOrder = filter === 'all' && !query;
  const { dragProps, move, error } = useResearchResourceOrder(researchId, 'card', ids, canOrder);
  const research = data.researches[researchId];
  if (!research) return <div className="empty-state">研究已缺失。</div>;
  const cards = ids.map(id => data.cards[id]).filter(card =>
    `${card.title} ${card.body}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === 'review' && card.needsReview || filter === 'unsourced' && !card.evidenceIds.length));
  const scope = { kind: 'research' as const, researchId };
  const open = (id: string) => actions.openResource({ kind: 'card', id }, { scope, target: 'main' });
  return <div className="page-content">
    <div className="library-heading"><div><h1>卡片</h1></div><div className="button-row">
      <button className="button" onClick={() => setPicker(!picker)}>添加已有卡片</button>
      <button className="primary" onClick={() => open(actions.createCard([], '新的观点', '', researchId))}><Plus size={15} />新建卡片</button></div></div>
    <div className="library-filters"><input aria-label="搜索研究卡片" placeholder="搜索卡片…" value={query} onChange={e => setQuery(e.target.value)} /><select aria-label="卡片筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部</option><option value="review">待核查</option><option value="unsourced">没有论文依据</option></select></div>
    <p className="card-order-hint">{canOrder ? '按本研究的手动顺序排列。拖动卡片或点击右上角手柄调整顺序。' : '清除搜索与筛选后可调整顺序。'}{!canOrder && <button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>清除筛选</button>}</p>
    {error && <p className="resource-order-error" role="alert">{error}</p>}
    {picker && <section className="question-box"><div><h3>添加已有卡片</h3>{Object.values(data.cards).filter(card => !research.cardIds.includes(card.id)).map(card => <button key={card.id} className="paper-row" onClick={() => { actions.associateCard(researchId, card.id); open(card.id); }}><strong>{card.title}</strong><span>加入本研究</span></button>)}<button className="text-button" onClick={() => setPicker(false)}>完成</button></div></section>}
    <div className="library-grid research-card-grid">{cards.map((card, index) => <article className="library-card card" key={card.id} {...dragProps(card.id)}><div className="card-order-heading"><button className="library-card-title" onClick={() => open(card.id)}><h3>{card.title}</h3></button><ResourceOrderControls title={card.title} previousId={ids[index - 1]} nextId={ids[index + 1]} disabled={!canOrder} onMove={(targetId, position) => move(card.id, targetId, position)}/></div><p>{card.body.slice(0, 180) || '写下你的理解…'}</p><div className="library-card-footer"><span className="muted">{card.evidenceIds.length} 条依据 · {card.needsReview ? '待核查' : '已核查'}</span>{!card.evidenceIds.length && <button className="button" onClick={() => actions.findEvidence(card.id)}>找依据</button>}<ResourceOpenMenu resource={{ kind: 'card', id: card.id }} scope={scope}/></div></article>)}</div>
    {!cards.length && <div className="empty-state">没有符合筛选的卡片。可以直接写观点，或从摘录写成卡片。</div>}
  </div>;
}
