import { Plus } from 'lucide-react';
import { useWorkspace, uid } from '../../services/workspace';

export function ResourceListView({ researchId, kind }: { researchId: string; kind: 'board' | 'draft' }) {
  const { data, actions } = useWorkspace();
  const items = Object.values(kind === 'board' ? data.boards : data.drafts).filter(item => item.researchId === researchId);
  const name = kind === 'board' ? '白板' : '文稿';
  function open(id: string) { actions.openResource({ kind, id }, { scope: { kind: 'research', researchId }, target: 'main' }); }
  return <div className="page-content">
    <div className="library-heading"><div><h1>{name}</h1><p className="page-lead">{kind === 'board' ? '摆放卡片，组织你的论证。' : '写下观点，保留引用与出处。'}</p></div>
      <button className="primary" onClick={() => {
        const id = uid(kind);
        actions.updateData(next => {
          if (kind === 'board') next.boards[id] = { id, researchId, title: `研究白板 ${items.length + 1}` };
          else next.drafts[id] = { id, researchId, title: `研究文稿 ${items.length + 1}`, body: '', evidenceIds: [], cardRefs: [] };
        }); open(id);
      }}><Plus size={15} />新建{name}</button></div>
    <div className="paper-list">{items.map(item => <button className="paper-row" key={item.id} onClick={() => open(item.id)}><strong>{item.title}</strong><span className="muted">打开 ↗</span></button>)}</div>
    {!items.length && <div className="empty-state">还没有{name}，可以从空白开始。</div>}
  </div>;
}
