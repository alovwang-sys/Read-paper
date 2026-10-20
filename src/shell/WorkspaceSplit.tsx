import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FolderOpen, Maximize2, Minimize2, PanelsTopLeft, Pin, Undo2, X } from 'lucide-react';
import type { PaneNode, ReaderTarget, ResourceAnchor, ResourceRef, Session, WorkspaceScope, WorkspaceTab, WorkspaceViewRef } from '../domain/types';
import { paneGroups } from '../services/panes';
import { PaneContext, RESOURCE_DRAG_MIME, RESOURCE_ORDER_DRAG_MIME } from '../services/pane-context';
import { resourceTitle, useWorkspace, workspace, registerReaderFlush } from '../services/workspace';
import { PaneTabs, PANE_TAB_MIME } from './PaneTabs';
import { paneDropAction, type PaneDragSource, type PaneDropAction, type PaneDropSide } from './pane-drag';
import './workspace-split.css';

type Group = Extract<PaneNode, { kind: 'group' }>;
type Side = PaneDropSide;
type Layout = NonNullable<Session['layout']>;
const directions = [
  ['left', '向左分屏', ArrowLeft], ['right', '向右分屏', ArrowRight],
  ['up', '向上分屏', ArrowUp], ['down', '向下分屏', ArrowDown],
] as const;
const clamp = (value: number) => Math.min(.9, Math.max(.1, value));

function readDrag(transfer: DataTransfer): PaneDragSource | undefined {
  try {
    if (transfer.types.includes(PANE_TAB_MIME)) {
      const payload = JSON.parse(transfer.getData(PANE_TAB_MIME));
      if (typeof payload?.tabId === 'string' && typeof payload?.scope === 'string') return { kind: 'tab', tabId: payload.tabId, scope: payload.scope };
    } else if (transfer.types.includes(RESOURCE_DRAG_MIME)) {
      const payload = JSON.parse(transfer.getData(RESOURCE_DRAG_MIME));
      if (typeof payload?.scope === 'string' && typeof payload?.ref?.id === 'string' && ['research', 'document', 'card', 'board', 'draft'].includes(payload?.ref?.kind)) return { kind: 'resource', scope: payload.scope, ref: { kind: payload.ref.kind, id: payload.ref.id } };
    }
  } catch { /* Protected or malformed drag data is checked again at drop. */ }
}

function minimumSize(node: PaneNode, zoomed?: string): { width: number; height: number } {
  if (node.kind === 'group') return { width: 320, height: 220 };
  const firstVisible = !zoomed || paneGroups(node.first).some(group => group.id === zoomed);
  const secondVisible = !zoomed || paneGroups(node.second).some(group => group.id === zoomed);
  if (!firstVisible) return minimumSize(node.second, zoomed);
  if (!secondVisible) return minimumSize(node.first, zoomed);
  const first = minimumSize(node.first), second = minimumSize(node.second), ratio = clamp(node.ratio);
  return node.axis === 'row'
    ? { width: Math.max(first.width / ratio, second.width / (1 - ratio)) + 5, height: Math.max(first.height, second.height) }
    : { width: Math.max(first.width, second.width), height: Math.max(first.height / ratio, second.height / (1 - ratio)) + 5 };
}

function PaneBody({ paneId, tab, scope, children, ...dragEvents }: {
  paneId: string; tab?: WorkspaceTab; scope: WorkspaceScope; children: ReactNode;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void; onDragLeave: (event: DragEvent<HTMLDivElement>) => void; onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const position = useRef<{ tabId: string; top: number } | undefined>(undefined);
  const scopeId = scope.kind === 'research' ? scope.researchId : 'library';
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !tab) return;
    const generation = workspace.getGeneration();
    const saved = { tabId: tab.id, top: Number(tab.viewState?.scrollTop ?? 0) };
    position.current = saved; element.scrollTop = saved.top;
    const persist = () => { if (workspace.getGeneration() === generation) workspace.setViewState({ scrollTop: saved.top }, tab.id, scope); };
    const flush = () => { saved.top = element.scrollTop; persist(); };
    const unregister = registerReaderFlush(`body:${scopeId}:${tab.id}`, flush);
    // Cleanup runs after the next view may have clamped the shared element's scrollTop.
    return () => { clearTimeout(pending.current); unregister(); persist(); };
  }, [tab?.id, scopeId]);
  return <div ref={body} className="workspace-pane-body" data-pane-content={paneId} {...dragEvents} onScroll={event => {
    if (!tab || event.target !== event.currentTarget) return;
    const saved = position.current, generation = workspace.getGeneration();
    if (saved?.tabId !== tab.id) return;
    saved.top = event.currentTarget.scrollTop;
    clearTimeout(pending.current);
    pending.current = setTimeout(() => { if (workspace.getGeneration() === generation) workspace.setViewState({ scrollTop: saved.top }, tab.id, scope); }, 150);
  }}>{tab ? <PaneContext.Provider value={{ paneId, tabId: tab.id, scope }}>{children}</PaneContext.Provider> : children}</div>;
}

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
  renderResource: (ref: WorkspaceViewRef, target: ReaderTarget, anchor?: ResourceAnchor, documentInfo?: boolean, tab?: WorkspaceTab) => ReactNode;
}) {
  const { data, session, actions } = useWorkspace();
  const layout = session.layout;
  const groups = layout ? paneGroups(layout.root) : [];
  const [dragSource, setDragSource] = useState<PaneDragSource>();
  const [orderingResource, setOrderingResource] = useState(false);
  const [preview, setPreview] = useState<PaneDropAction>();
  const [menu, setMenu] = useState<{ paneId: string; tabId?: string }>();
  const [undoLabel, setUndoLabel] = useState<string>();
  const menuElement = useRef<HTMLDivElement>(null);
  const scoped = data.scope.kind === 'research' ? data.scope.researchId : 'library';
  useEffect(() => { setMenu(undefined); setPreview(undefined); setDragSource(undefined); setUndoLabel(undefined); }, [scoped]);
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer) return;
      setDragSource(readDrag(event.dataTransfer));
      setOrderingResource(event.dataTransfer.types.includes(RESOURCE_ORDER_DRAG_MIME));
    };
    const end = () => { setDragSource(undefined); setPreview(undefined); setOrderingResource(false); };
    window.addEventListener('dragstart', start); window.addEventListener('dragend', end); window.addEventListener('drop', end);
    return () => { window.removeEventListener('dragstart', start); window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, []);
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

  function execute(action: () => void, undo?: string) {
    try { action(); if (undo) setUndoLabel(undo); } catch (problem) { actions.notice(problem instanceof Error ? problem.message : '操作暂时未完成，请重试。'); }
    setMenu(undefined);
  }
  function accepts(event: DragEvent) { return event.dataTransfer.types.includes(PANE_TAB_MIME) || event.dataTransfer.types.includes(RESOURCE_DRAG_MIME); }
  function finishDrag() { setDragSource(undefined); setPreview(undefined); setOrderingResource(false); }
  function drop(event: DragEvent, paneId: string, side: Side, index?: number) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    const source = readDrag(event.dataTransfer);
    if (source?.scope === scoped) {
      const action = paneDropAction(source, groups, paneId, side, event.altKey, index);
      if (action && action.mode !== 'none') execute(() => source.kind === 'resource' ? actions.openInPane(source.ref, paneId, side) : actions.movePaneTab(source.tabId, paneId, side, action.mode === 'copy', index));
    } else actions.notice(source ? '请在原研究中打开或移动内容。' : '没有识别到可打开的内容，请重试。');
    finishDrag();
  }
  function dropSide(event: DragEvent, paneId: string): Side {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height;
    const edges: [Side, number][] = [['left', x], ['right', 1 - x], ['up', y], ['down', 1 - y]];
    edges.sort((a, b) => a[1] - b[1]);
    const previous = preview?.paneId === paneId && preview.index === undefined && preview.side !== 'center' ? edges.find(edge => edge[0] === preview.side) : undefined;
    if (previous && previous[1] < .25 && previous[1] <= edges[0][1] + .035) return previous[0];
    return edges[0][1] < .23 ? edges[0][0] : 'center';
  }
  function dragOver(event: DragEvent, paneId: string, index?: number) {
    if (!accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    const source = dragSource ?? readDrag(event.dataTransfer);
    const action = source?.scope === scoped ? paneDropAction(source, groups, paneId, index === undefined ? dropSide(event, paneId) : 'center', event.altKey, index) : undefined;
    event.dataTransfer.dropEffect = action?.effect ?? 'none';
    setPreview(action);
  }
  function openMenu(paneId: string, tabId?: string) {
    if (tabId) actions.activatePane(paneId, tabId);
    setMenu(previous => previous?.paneId === paneId && (!tabId || previous.tabId === tabId) ? undefined : { paneId, tabId });
  }

  function renderMenu(group: Group, number: number) {
    if (menu?.paneId !== group.id || !layout) return null;
    const tab = group.tabs.find(item => item.id === menu.tabId) ?? group.tabs.find(item => item.id === group.activeTabId) ?? group.tabs[0];
    const pinned = !!tab && session.pinnedIds.includes(tab.ref.id);
    const resource = tab && (tab.ref.kind === 'document' || tab.ref.kind === 'card' || tab.ref.kind === 'board' || tab.ref.kind === 'draft' || tab.ref.kind === 'research') ? tab.ref : undefined;
    function position(node: PaneNode, id: string): string {
      if (node.kind === 'group') return '';
      const first = paneGroups(node.first).some(pane => pane.id === id);
      return `${node.axis === 'row' ? first ? '左侧' : '右侧' : first ? '上方' : '下方'} ${position(first ? node.first : node.second, id)}`.trim();
    }
    return <div ref={menuElement} className="pane-group-menu" role="menu" aria-label={`窗格 ${number} 操作菜单`} onKeyDown={event => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(undefined); document.querySelector<HTMLButtonElement>(`[data-pane-menu-trigger="${CSS.escape(group.id)}"]`)?.focus(); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
    }}>
      {directions.map(([direction, label, Icon]) => <button key={direction} role="menuitem" onClick={() => execute(() => actions.splitPane(group.id, direction, tab?.id))}><Icon size={14} />{label}</button>)}
      <hr />
      <button role="menuitem" disabled={groups.length < 2} onClick={() => execute(() => actions.togglePaneZoom(group.id))}>{layout.zoomedPaneId === group.id ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{layout.zoomedPaneId === group.id ? '还原窗格布局' : '放大当前窗格'}</button>
      <button role="menuitem" disabled={groups.length < 2} onClick={() => execute(() => actions.mergePanes(group.id), '已收拢窗格')}><PanelsTopLeft size={14} />收拢所有标签</button>
      {resource && <button role="menuitem" onClick={() => execute(() => actions.pinResource(resource))}><Pin size={14} />{pinned ? '取消固定当前标签' : '固定当前标签'}</button>}
      {tab && groups.length > 1 && <><hr />{groups.filter(item => item.id !== group.id).map(other => {
        const active = other.tabs.find(item => item.id === other.activeTabId);
        const label = `${position(layout.root, other.id)} · ${active ? resourceTitle(data, active.ref) : '空窗格'}`;
        return <button key={other.id} role="menuitem" title={label} onClick={() => execute(() => actions.movePaneTab(tab.id, other.id))}><ArrowRight size={14} /><span>移到 {label}</span></button>;
      })}</>}
      {tab && <><hr /><button role="menuitem" onClick={() => execute(() => actions.closePaneTab(group.id, tab.id))}><X size={14} />关闭当前标签</button></>}
      <button role="menuitem" onClick={() => execute(() => actions.closePane(group.id), '已关闭窗格')}><X size={14} />关闭窗格</button>
    </div>;
  }

  function renderGroup(group: Group, current: Layout) {
    const number = groups.findIndex(item => item.id === group.id) + 1;
    const active = group.tabs.find(tab => tab.id === group.activeTabId) ?? group.tabs[0];
    const dropHere = preview?.paneId === group.id && preview.index === undefined ? preview : undefined;
    const orderingCards = orderingResource && active?.ref.kind === 'researchView' && active.ref.id === 'cards';
    const receivingDrag = dragSource?.scope === scoped && !orderingCards;
    return <section key={group.id} className={`workspace-pane-group ${current.focusedPaneId === group.id ? 'is-focused' : ''}`} role="region" aria-label={`工作区窗格 ${number}`} data-pane-id={group.id} data-focused={current.focusedPaneId === group.id ? 'true' : 'false'}
      onDragOverCapture={event => {
        if (orderingCards && (event.target as HTMLElement).closest('[data-order-id]')) setPreview(undefined);
      }}
      onPointerDownCapture={() => { if (current.focusedPaneId !== group.id) actions.activatePane(group.id); }}
      onFocusCapture={() => { if (current.focusedPaneId !== group.id) actions.activatePane(group.id); }}>
      <PaneTabs group={group} number={number} title={ref => resourceTitle(data, ref)} pinnedIds={session.pinnedIds} menuOpen={menu?.paneId === group.id}
        zoomed={current.zoomedPaneId === group.id} canZoom={groups.length > 1} onZoom={() => execute(() => actions.togglePaneZoom(group.id))}
        onActivate={tabId => actions.activatePane(group.id, tabId)} onClose={tabId => execute(() => actions.closePaneTab(group.id, tabId))}
        onMenu={tabId => openMenu(group.id, tabId)} onMove={(tabId, index) => execute(() => actions.movePaneTab(tabId, group.id, 'center', false, index))}
        onDragStart={(event, tabId) => { event.dataTransfer.setData(PANE_TAB_MIME, JSON.stringify({ scope: scoped, tabId })); event.dataTransfer.setData('text/plain', tabId); event.dataTransfer.effectAllowed = 'copyMove'; setDragSource({ kind: 'tab', tabId, scope: scoped }); }} onDragEnd={finishDrag}
        accepts={accepts} onDragOver={(event, index) => dragOver(event, group.id, index)}
        onDrop={(event, index) => drop(event, group.id, 'center', index)} dropIndex={preview?.paneId === group.id ? preview.index : undefined} />
      <PaneBody paneId={group.id} tab={active} scope={data.scope} onDragOver={event => dragOver(event, group.id)} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPreview(undefined); }} onDrop={event => drop(event, group.id, dropSide(event, group.id))}>
        {active ? renderResource(active.ref, `view:${active.id}`, active.anchor, active.documentInfo, active) : <div className="pane-empty" tabIndex={0}><PanelsTopLeft size={23} /><p>打开内容，开始阅读与整理</p><button onClick={() => execute(() => { actions.activatePane(group.id); if (data.scope.kind === 'research') actions.openResearchView(data.scope.researchId, 'sources'); else actions.openCollection('documents'); })}><FolderOpen size={14} />打开资料</button><span>或将标签、资料拖到这里</span></div>}
      </PaneBody>
      {/* PDF loading replaces its inner DOM; keep the native drop target stable throughout a drag. */}
      {(receivingDrag || dropHere) && <div className={`pane-drop-layer ${receivingDrag ? 'is-drag-receiver' : ''}`} data-pane-drop-receiver={group.id}
        onDragOver={event => dragOver(event, group.id)} onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setPreview(undefined); }}
        onDrop={event => drop(event, group.id, dropSide(event, group.id))}>
        {dropHere && <div className={`pane-drop-preview drop-${dropHere.side} ${dropHere.mode === 'none' ? 'is-noop' : ''}`} data-drop-side={dropHere.side} data-drop-mode={dropHere.mode} role="status"><span>{dropHere.label}</span></div>}
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
  const minimum = minimumSize(layout.root, layout.zoomedPaneId);
  return <section className={`workspace-panes ${groups.length > 1 ? 'has-multiple-panes' : ''} ${layout.zoomedPaneId ? 'has-zoomed-pane' : ''}`} aria-label="中央窗格工作区" onKeyDown={event => {
    if (event.key === 'Escape' && dragSource) { event.preventDefault(); event.stopPropagation(); finishDrag(); }
  }} onDragEnd={finishDrag}>
    <div className="workspace-pane-scroll"><div className="workspace-pane-canvas" style={{ minWidth: minimum.width, minHeight: minimum.height }}>{renderTree(layout.root, layout)}</div></div>
    {undoLabel && actions.canUndoPaneLayout() && <div className="pane-layout-undo" role="status"><span>{undoLabel}</span><button onClick={() => execute(() => { actions.undoPaneLayout(); setUndoLabel(undefined); })}><Undo2 size={13} />撤销</button><button className="pane-undo-dismiss" aria-label="关闭撤销提示" onClick={() => setUndoLabel(undefined)}><X size={12} /></button></div>}
  </section>;
}
