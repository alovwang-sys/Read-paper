import { useState } from 'react';
import { BookOpen, Layers, Quote, Sparkles } from 'lucide-react';
import { generateCardDraftFromExcerpts, demoResponder } from '../../services/ai';
import { usePaneViewState, useWorkspace } from '../../services/workspace';
import { EvidenceList } from './EvidenceList';
import './evidence.css';

export function ExcerptsView({ researchId }: { researchId: string }) {
  const { data, loaded, loadError, actions } = useWorkspace();
  const [filter, setFilter] = usePaneViewState<'all' | 'unused' | 'used'>('filter', 'all');
  const [showDismissed, setShowDismissed] = usePaneViewState<boolean>('showDismissed', false);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const research = data.researches[researchId];
  if (!loaded) return <div className="empty-state" role="status">正在加载摘录…</div>;
  if (loadError || !research) return <div className="empty-state" role="alert">{loadError || '研究已缺失，请重新打开。'}</div>;
  const used = new Set(research.cardIds.flatMap(id => data.cards[id]?.evidenceIds ?? []));
  const all = Object.values(data.evidence).filter(item => research.documentIds.includes(item.documentId));
  const own = all.filter(item => !item.researchId || item.researchId === researchId);
  const visible = own.filter(item => (showDismissed || !item.dismissed) && (filter === 'all' || used.has(item.id) === (filter === 'used')));
  const ids = selected.filter(id => visible.some(item => item.id === id));
  const scope = { kind: 'research' as const, researchId };
  function execute(action: () => void) {
    try { action(); setError(''); } catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败，请重试。'); }
  }
  async function generate() {
    setGenerating(true); setError('');
    try {
      const conversation = actions.getActiveConversation(researchId);
      await generateCardDraftFromExcerpts(researchId, ids, conversation.connectionId === 'demo' ? demoResponder : undefined);
    } catch (problem) { setError(problem instanceof Error ? problem.message : '起草失败，已保留草稿，可在右侧重试。'); }
    finally { setGenerating(false); }
  }
  return <section className="excerpts-view" aria-label="研究摘录">
    <div className="excerpts-heading"><div><h1>摘录</h1></div><Quote size={24} /></div>
    <div className="excerpts-filters" role="group" aria-label="摘录筛选">
      {([['all', '全部'], ['unused', '还没用到'], ['used', '已用于卡片']] as const).map(([value, label]) => <button className={`button ${filter === value ? 'active' : ''}`} key={value} aria-pressed={filter === value} onClick={() => { setFilter(value); setSelected([]); }}>{label}</button>)}
      {filter === 'all' && <label className="excerpts-show-dismissed"><input type="checkbox" checked={showDismissed} onChange={event => setShowDismissed(event.target.checked)} />显示标为不需要的摘录</label>}
    </div>
    {error && <p className="evidence-missing" role="alert">{error}</p>}
    {!visible.length && <div className="empty-state"><Quote size={32} /><h3>{own.length ? '这个筛选下没有摘录' : '把与你的问题有关的原文留下来'}</h3><p>在 PDF 中选择文字，点击“摘录”或按 H。</p><button className="button" onClick={() => actions.openResearchView(researchId, 'sources')}><BookOpen size={14} />去资料里阅读</button></div>}
    {research.documentIds.map(documentId => {
      const items = visible.filter(item => item.documentId === documentId);
      const other = all.filter(item => item.documentId === documentId && !!item.researchId && item.researchId !== researchId);
      if (!items.length && !other.length) return null;
      return <section className="excerpt-group" key={documentId} aria-label={`摘录分组：${data.documents[documentId]?.title ?? '资料已缺失'}`}>
        <h2><BookOpen size={16} />{data.documents[documentId]?.title ?? '资料已缺失'}</h2>
        {items.map(item => <div className={`excerpt-selectable ${ids.includes(item.id) ? 'selected' : ''}`} key={item.id}>
          <label className="excerpt-checkbox"><input type="checkbox" aria-label={`选择摘录：${item.quote || '区域摘录'}`} checked={ids.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...new Set([...current, item.id])] : current.filter(id => id !== item.id))} /><span>选择摘录</span></label>
          <EvidenceList evidenceIds={[item.id]} target="main" heading="" showNote />
        </div>)}
        {!!other.length && <details className="other-research-excerpts"><summary>其他研究的摘录 {other.length}</summary><EvidenceList evidenceIds={other.map(item => item.id)} target="main" heading="" showNote /></details>}
      </section>;
    })}
    {!!ids.length && <div className="excerpts-selection-bar" role="region" aria-label="所选摘录操作"><strong>已选 {ids.length} 条摘录</strong><button className="button" onClick={() => execute(() => { const id = actions.createCard(ids, '新的观点', '', researchId); actions.openResource({ kind: 'card', id }, { scope, target: 'inspector' }); })}><Layers size={14} />写成一张卡片</button><button className="button primary" disabled={generating} onClick={() => void generate()}><Sparkles size={14} />{generating ? '正在起草…' : 'AI 起草'}</button><button className="text-button" onClick={() => execute(() => { actions.updateData(next => { for (const id of ids) next.evidence[id].dismissed = true; }); setSelected([]); })}>不需要</button><button className="text-button" onClick={() => setSelected([])}>取消选择</button></div>}
  </section>;
}
