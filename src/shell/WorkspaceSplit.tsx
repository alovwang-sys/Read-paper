import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Maximize2, Minimize2, PanelsTopLeft, Pin, X } from 'lucide-react';
import type { PaneNode, ReaderTarget, ResourceAnchor, ResourceRef, Session } from '../domain/types';
import { paneGroups } from '../services/panes';
import { resourceTitle, useWorkspace } from '../services/workspace';
import { PaneTabs, PANE_TAB_MIME } from './PaneTabs';
import './workspace-split.css';

type Group = Extract<PaneNode, { kind: 'group' }>;
type Side = 'left' | 'right' | 'up' | 'down' | 'center';
type Preview = { paneId: string; side: Side; copy: boolean; index?: number };
type Layout = NonNullable<Session['layout']>;
const directions = [
  ['left', '向左分屏', ArrowLeft], ['right', '向右分屏', ArrowRight],
  ['up', '向上分屏', ArrowUp], ['down', '向下分屏', ArrowDown],
] as const;
const clamp = (value: number) => Math.min(.9, Math.max(.1, value));

function SplitNode({ node, firstHidden, secondHidden, resize, children }: {
  node: Extract<PaneNode, { kind: 'split' }>; firstHidden: boolean; secondHidden: boolean;
  resize: (id: string, ratio: number) => void; children: [ReactNode, ReactNode];
}) {
  const element = useRef<HTMLDivElement>(null);
  const dragging = useRef<DOMRect | undefined>(undefined);
  const currentRatio = useRef(node.ratio);
  const [previewRatio, setPreviewRatio] = useState<number>();
  const ratio = previewRatio ?? node.ratio;
  const row = node.axis === 'row';
  return <div ref={element} className={`workspace-split-node axis-${node.axis}`} data-split-id={node.id}>
    <div className="workspace-split-slot" hidden={firstHidden} style={{ flex: firstHidden || secondHidden ? '1 1 0' : `${ratio} 1 0` }}>{children[0]}</div>
    {!firstHidden && !secondHidden && <div role="separator" className={`pane-divider ${previewRatio === undefined ? '' : 'is-dragging'}`} aria-label={`调整窗格分隔 ${node.id}`} aria-orientation={row ? 'vertical' : 'horizontal'} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(ratio * 100)} tabIndex={0}
      onKeyDown={event => {
        const negative = row ? 'ArrowLeft' : 'ArrowUp', positive = row ? 'ArrowRight' : 'ArrowDown';
        if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        resize(node.id, event.key === 'Home' ? .1 : event.key === 'End' ? .9 : clamp(node.ratio + (event.key === positive ? 1 : -1) * (event.shiftKey ? .1 : .02)));
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = element.current!.getBoundingClientRect(); currentRatio.current = node.ratio;
      }}
      onPointerMove={event => {
        const bounds = dragging.current; if (!bounds) return;
        const next = clamp(row ? (event.clientX - bounds.left) / bounds.width : (event.clientY - bounds.top) / bounds.height);
        currentRatio.current = next; setPreviewRatio(next);
      }}
      onPointerUp={event => {
        if (!dragging.current) return;
        dragging.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        resize(node.id, currentRatio.current); setPreviewRatio(undefined);
      }}
      onPointerCancel={() => { dragging.current = undefined; setPreviewRatio(undefined); }} />}
    <div className="workspace-split-slot" hidden={secondHidden} style={{ flex: firstHidden || secondHidden ? '1 1 0' : `${1 - ratio} 1 0` }}>{children[1]}</div>
  </div>;
}

export function WorkspaceSplit({ renderResource }: {
  primary?: ResourceRef;
  renderResource: (ref: ResourceRef, target: ReaderTarget, anchor?: ResourceAnchor, documentInfo?: boolean) => ReactNode;
}) {
  const { data, session, actions } = useWorkspace();
  const layout = session.layout;
  const groups = layout ? paneGroups(layout.root) : [];
  const [draggedTab, setDraggedTab] = useState<{ id: string; scope: string }>();
  const [preview, setPreview] = useState<Preview>();
  const [menu, setMenu] = useState<{ paneId: string; tabId?: string }>();
  const menuElement = useRef<HTMLDivElement>(null);
  const scoped = data.scope.kind === 'research' ? data.scope.researchId : 'library';
  useEffect(() => { setMenu(undefined); setPreview(undefined); setDraggedTab(undefined); }, [scoped]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>('[role=menuitem]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (!menuElement.current?.contains(target) && !target.closest('[data-pane-menu-trigger]')) setMenu(undefined);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [menu?.paneId, menu?.tabId]);

  function execute(action: () => void) {
    try { action(); } catch (problem) { actions.notice(problem instanceof Error ? problem.message : '操作暂时未完成，请重试。'); }
    setMenu(undefined);
  }
  function accepts(event: DragEvent) { return draggedTab ? draggedTab.scope === scoped : event.dataTransfer.types.includes(PANE_TAB_MIME); }
  function finishDrag() { setDraggedTab(undefined); setPreview(undefined); }
  function drop(event: DragEvent, paneId: string, side: Side, index?: number) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    let source: { id: string; scope: string } | undefined = draggedTab;
    try {
      const payload = JSON.parse(event.dataTransfer.getData(PANE_TAB_MIME));
      if (typeof payload?.tabId === 'string' && typeof payload?.scope === 'string') source = { id: payload.tabId, scope: payload.scope };
      else source = undefined;
    } catch { source = undefined; }
    if (source?.scope === scoped) execute(() => actions.movePaneTab(source!.id, paneId, side, event.altKey || !!preview?.copy, index));
    else actions.notice('请在原研究中移动或复制标签。');
    finishDrag();
  }
  function dragOver(event: DragEvent<HTMLElement>, paneId: string) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
    const edges: [Side, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
    edges.sort((a, b) => a[1] - b[1]);
    const side = edges[0][1] < .23 ? edges[0][0] : 'center';
    const source = groups.find(group => group.tabs.some(tab => tab.id === draggedTab?.id));
    const copy = event.altKey || side !== 'center' && source?.id === paneId && source.tabs.length === 1;
    event.dataTransfer.dropEffect = copy ? 'copy' : 'move';
    setPreview({ paneId, side, copy });
  }
  function openMenu(paneId: string, tabId?: string) {
    if (tabId) actions.activatePane(paneId, tabId);
    setMenu(previous => previous?.paneId === paneId && (!tabId || previous.tabId === tabId) ? undefined : { paneId, tabId });
  }

  function renderMenu(group: Group, number: number) {
    if (menu?.paneId !== group.id || !layout) return null;
    const tab = group.tabs.find(item => item.id === menu.tabId) ?? group.tabs.find(item => item.id === group.activeTabId) ?? group.tabs[0];
    const pinned = !!tab && session.pinnedIds.includes(tab.ref.id);
    return <div ref={menuElement} className="pane-group-menu" role="menu" aria-label={`窗格 ${number} 操作菜单`} onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); document.querySelector<HTMLButtonElement>(`[data-pane-menu-trigger="${CSS.escape(group.id)}"]`)?.focus(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}>
      <span className="pane-menu-heading">拆分后在两处查看当前内容</span>
      {directions.map(([direction, label, Icon]) => <button key={direction} role="menuitem" disabled={!tab} onClick={() => execute(() => actions.splitPane(group.id, direction, tab?.id))}><Icon size={14} />{label}</button>)}
      <hr />
      <button role="menuitem" onClick={() => execute(() => actions.togglePaneZoom(group.id))}>{layout.zoomedPaneId === group.id ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{layout.zoomedPaneId === group.id ? '还原窗格布局' : '放大当前窗格'}</button>
      <button role="menuitem" disabled={groups.length < 2} onClick={() => execute(() => actions.mergePanes(group.id))}><PanelsTopLeft size={14} />收拢为一个窗格</button>
      {tab && <button role="menuitem" onClick={() => execute(() => actions.pinResource(tab.ref))}><Pin size={14} />{pinned ? '取消固定当前标签' : '固定当前标签'}</button>}
      {tab && groups.length > 1 && <><hr /><span className="pane-menu-heading">移动当前标签</span>{groups.filter(item => item.id !== group.id).map(other => {
        const index = groups.indexOf(other) + 1;
        const active = other.tabs.find(item => item.id === other.activeTabId);
        return <button key={other.id} role="menuitem" title={active ? resourceTitle(data, active.ref) : '空窗格'} onClick={() => execute(() => actions.movePaneTab(tab.id, other.id))}><ArrowRight size={14} />移到窗格 {index}</button>;
      })}</>}
      {tab && <><hr /><button role="menuitem" onClick={() => execute(() => actions.closePaneTab(group.id, tab.id))}><X size={14} />关闭当前标签</button></>}
    </div>;
  }

  function renderGroup(group: Group, current: Layout) {
    const number = groups.findIndex(item => item.id === group.id) + 1;
    const active = group.tabs.find(tab => tab.id === group.activeTabId) ?? group.tabs[0];
    const dropHere = preview?.paneId === group.id && preview.index === undefined ? preview : undefined;
    const receivingDrag = draggedTab?.scope === scoped;
    return <section key={group.id} className={`workspace-pane-group ${current.focusedPaneId === group.id ? 'is-focused' : ''}`} role="region" aria-label={`工作区窗格 ${number}`} data-pane-id={group.id} data-focused={current.focusedPaneId === group.id ? 'true' : 'false'}
      onPointerDownCapture={() => { if (current.focusedPaneId !== group.id) actions.activatePane(group.id); }}
      onFocusCapture={() => { if (current.focusedPaneId !== group.id) actions.activatePane(group.id); }}>
      <PaneTabs group={group} number={number} title={ref => resourceTitle(data, ref)} pinnedIds={session.pinnedIds} menuOpen={menu?.paneId === group.id}
        onActivate={tabId => actions.activatePane(group.id, tabId)} onClose={tabId => execute(() => actions.closePaneTab(group.id, tabId))}
        onMenu={tabId => openMenu(group.id, tabId)} onMove={(tabId, index) => execute(() => actions.movePaneTab(tabId, group.id, 'center', false, index))}
        onDragStart={(event, tabId) => { event.dataTransfer.setData(PANE_TAB_MIME, JSON.stringify({ scope: scoped, tabId })); event.dataTransfer.setData('text/plain', tabId); event.dataTransfer.effectAllowed = 'copyMove'; setDraggedTab({ id: tabId, scope: scoped }); }} onDragEnd={finishDrag}
        accepts={accepts} onDragOver={(event, index) => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = event.altKey ? 'copy' : 'move'; setPreview({ paneId: group.id, side: 'center', copy: event.altKey, index }); }}
        onDrop={(event, index) => drop(event, group.id, 'center', index)} dropIndex={preview?.paneId === group.id ? preview.index : undefined} />
      <div className="workspace-pane-body" data-pane-content={group.id} onDragOver={event => dragOver(event, group.id)} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPreview(undefined); }} onDrop={event => drop(event, group.id, preview?.paneId === group.id ? preview.side : 'center')}>
        {active ? renderResource(active.ref, `view:${active.id}`, active.anchor, active.documentInfo) : <div className="pane-empty" tabIndex={0}><PanelsTopLeft size={25} /><p>从资料或卡片中打开内容</p><span>也可以把标签拖到这里。</span></div>}
      </div>
      {/* PDF loading replaces its inner DOM; keep the native drop target stable throughout a drag. */}
      {(receivingDrag || dropHere) && <div className={`pane-drop-layer ${receivingDrag ? 'is-drag-receiver' : ''}`} data-pane-drop-receiver={group.id}
        onDragOver={event => dragOver(event, group.id)} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPreview(undefined); }}
        onDrop={event => drop(event, group.id, preview?.paneId === group.id ? preview.side : 'center')}>
        {dropHere && <div className={`pane-drop-preview drop-${dropHere.side}`} data-drop-side={dropHere.side} role="status"><span>{dropHere.copy ? '复制' : '移动'}到{dropHere.side === 'center' ? '此窗格' : ({ left: '左侧新窗格', right: '右侧新窗格', up: '上方新窗格', down: '下方新窗格' } as const)[dropHere.side]}</span></div>}
      </div>}
      {renderMenu(group, number)}
    </section>;
  }

  function renderTree(node: PaneNode, current: Layout): ReactNode {
    if (node.kind === 'group') return renderGroup(node, current);
    const hidden = (child: PaneNode) => !!current.zoomedPaneId && !paneGroups(child).some(group => group.id === current.zoomedPaneId);
    return <SplitNode key={node.id} node={node} firstHidden={hidden(node.first)} secondHidden={hidden(node.second)} resize={(id, ratio) => execute(() => actions.resizePane(id, ratio))}>{[renderTree(node.first, current), renderTree(node.second, current)]}</SplitNode>;
  }
  if (!layout) return <div className="pane-empty">正在恢复窗格…</div>;
  return <section className={`workspace-panes ${groups.length > 1 ? 'has-multiple-panes' : ''} ${layout.zoomedPaneId ? 'has-zoomed-pane' : ''}`} aria-label="中央窗格工作区" onKeyDown={event => {
    if (event.key === 'Escape' && draggedTab) { event.preventDefault(); event.stopPropagation(); finishDrag(); }
  }} onDragEnd={finishDrag}>{renderTree(layout.root, layout)}</section>;
}
