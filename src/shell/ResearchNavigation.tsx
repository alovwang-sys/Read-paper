import { useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, FileText, Home, Layers, LayoutGrid, Network, NotebookPen } from 'lucide-react';
import type { ResearchViewId, ResourceRef, WorkspaceViewRef } from '../domain/types';
import { researchResourceIds } from '../domain/research-order';
import { useWorkspace } from '../services/workspace';
import { ResourceOrderControls, useResearchResourceOrder } from '../ui/ResourceOrderControls';
import './research-navigation.css';

export const researchViews = [
  { id: 'home', name: '研究主页', icon: Home },
  { id: 'sources', name: '资料', icon: BookOpen, group: '阅读' },
  { id: 'excerpts', name: '摘录', icon: FileText },
  { id: 'cards', name: '卡片', icon: Layers, group: '思考与写作' },
  { id: 'boards', name: '白板', icon: LayoutGrid },
  { id: 'drafts', name: '文稿', icon: NotebookPen },
] as const;
type Props = { researchId: string; active: WorkspaceViewRef; onNavigate: (id: ResearchViewId) => void; onOpen: (ref: ResourceRef) => void };

function ResourceSection({ researchId, active, onNavigate, onOpen, id }: Props & { id: 'boards' | 'drafts' }) {
  const { data, actions } = useWorkspace();
  const [error, setError] = useState('');
  const kind = id === 'boards' ? 'board' : 'draft';
  const name = id === 'boards' ? '白板' : '文稿';
  const Icon = id === 'boards' ? LayoutGrid : NotebookPen;
  const ChildIcon = id === 'boards' ? Network : FileText;
  const ids = researchResourceIds(data, researchId, kind);
  const { dragProps, move, error: orderError } = useResearchResourceOrder(researchId, kind, ids);
  const collapsed = data.sessions[researchId]?.collapsedNav?.includes(id) ?? false;
  const toggle = () => {
    try {
      actions.updateData(next => {
        const session = next.sessions[researchId];
        if (!session) throw new Error('研究会话已缺失，请重新打开研究。');
        session.collapsedNav = collapsed ? (session.collapsedNav ?? []).filter(item => item !== id) : [...(session.collapsedNav ?? []), id];
      });
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导航状态保存失败，请重试。'); }
  };
  return <div className="research-nav-section" data-nav-kind={kind}>
    <div className="research-nav-parent">
      <button className={`nav-item ${active.kind === 'researchView' && active.id === id ? 'active' : ''}`} onClick={() => onNavigate(id)}><Icon size={16}/><span>{name}</span></button>
      <button className="research-nav-toggle" aria-label={`${collapsed ? '展开' : '收起'}${name}列表`} aria-expanded={!collapsed} aria-controls={`research-${researchId}-${id}`} onClick={toggle}>{collapsed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}</button>
    </div>
    {!collapsed && <div id={`research-${researchId}-${id}`} className="research-nav-children">
      {ids.map((resourceId, index) => {
        const resource = (kind === 'board' ? data.boards : data.drafts)[resourceId];
        return <div key={resourceId} className="research-nav-resource" {...dragProps(resourceId)}>
          <button className={`nav-item nested-nav ${active.kind === kind && active.id === resourceId ? 'active' : ''}`} title={resource.title} onClick={() => onOpen({ kind, id: resourceId })}><ChildIcon size={14}/><span>{resource.title}</span></button>
          <ResourceOrderControls title={resource.title} previousId={ids[index - 1]} nextId={ids[index + 1]} onMove={(targetId, position) => move(resourceId, targetId, position)}/>
        </div>;
      })}
      {!ids.length && <p className="research-nav-empty">暂无{name}</p>}
    </div>}
    {(error || orderError) && <p className="resource-order-error" role="alert">{error || orderError}</p>}
  </div>;
}

export function ResearchNavigation(props: Props) {
  return <nav className="research-nav research-hierarchy" aria-label="研究内导航">
    {researchViews.map(view => view.id === 'boards' || view.id === 'drafts' ? <ResourceSection key={view.id} {...props} id={view.id}/> : <div key={view.id}>
      {'group' in view && <div className="sidebar-section-label">{view.group}</div>}
      <button className={`nav-item ${props.active.kind === 'researchView' && props.active.id === view.id ? 'active' : ''}`} onClick={() => props.onNavigate(view.id)}><view.icon size={16}/>{view.name}</button>
    </div>)}
  </nav>;
}
