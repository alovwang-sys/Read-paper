import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { researchResourceIds } from '../../domain/research-order';
import { useWorkspace, uid } from '../../services/workspace';
import { ResourceOpenMenu, startResourceDrag } from '../library/ResourceOpenMenu';
import { BoardRenameDialog } from '../board/BoardRenameDialog';
import './research.css';

export function ResourceListView({ researchId, kind }: { researchId: string; kind: 'board' | 'draft' }) {
  const { data, actions } = useWorkspace();
  const [renaming, setRenaming] = useState<string>();
  const dragged = useRef<string | undefined>(undefined);
  useEffect(() => { setRenaming(undefined); dragged.current = undefined; }, [researchId, kind]);
  const resources = kind === 'board' ? data.boards : data.drafts;
  const items = researchResourceIds(data, researchId, kind).map(id => resources[id]);
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
    <div className="paper-list">{items.map(item => <article className="paper-row resource-list-row" key={item.id} draggable onPointerDown={() => { dragged.current = undefined; }} onDragStart={event => { dragged.current = item.id; startResourceDrag(event, { kind, id: item.id }, scope); }}><button className="source-title resource-list-open" onClick={event => {
      if (event.detail && dragged.current === item.id) { dragged.current = undefined; return; }
      dragged.current = undefined; open(item.id);
    }}><strong>{item.title}</strong></button><ResourceOpenMenu resource={{ kind, id: item.id }} scope={scope} onRename={kind === 'board' ? () => setRenaming(item.id) : undefined}/></article>)}</div>
    {renaming && data.boards[renaming]?.researchId === researchId && <BoardRenameDialog key={renaming} boardId={renaming} onClose={() => setRenaming(undefined)}/>}
    {!items.length && <div className="empty-state">还没有{name}，可以从空白开始。</div>}
  </div>;
}
