import { Plus } from 'lucide-react';
import { useWorkspace, uid } from '../../services/workspace';
import { ResourceOpenMenu, startResourceDrag } from '../library/ResourceOpenMenu';
import './research.css';

export function ResourceListView({ researchId, kind }: { researchId: string; kind: 'board' | 'draft' }) {
  const { data, actions } = useWorkspace();
  const items = Object.values(kind === 'board' ? data.boards : data.drafts).filter(item => item.researchId === researchId);
  const name = kind === 'board' ? '白板' : '文稿';
  const scope = { kind: 'research' as const, researchId };
  function open(id: string) { actions.openResource({ kind, id }, { scope, target: 'main' }); }
  return <div className="page-content">
    <div className="library-heading"><div><h1>{name}</h1></div>
      <button className="primary" onClick={() => {
        const id = uid(kind);
        actions.updateData(next => {
          if (kind === 'board') next.boards[id] = { id, researchId, title: `研究白板 ${items.length + 1}` };
          else next.drafts[id] = { id, researchId, title: `研究文稿 ${items.length + 1}`, body: '', evidenceIds: [], cardRefs: [] };
        }); open(id);
      }}><Plus size={15} />新建{name}</button></div>
    <div className="paper-list">{items.map(item => <article className="paper-row" key={item.id} draggable onDragStart={event => startResourceDrag(event, { kind, id: item.id }, scope)}><button className="source-title" onClick={() => open(item.id)}><strong>{item.title}</strong></button><ResourceOpenMenu resource={{ kind, id: item.id }} scope={scope}/></article>)}</div>
    {!items.length && <div className="empty-state">还没有{name}，可以从空白开始。</div>}
  </div>;
}
