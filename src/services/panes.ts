import { hasFullText } from '../domain/knowledge';
import type { PaneGroup, PaneNode, ReaderTarget, ReadingPosition, ResourceRef, Session, WorkspaceData, WorkspaceLayout, WorkspaceTab } from '../domain/types';

export const paneGroups = (node: PaneNode): PaneGroup[] => node.kind === 'group' ? [node] : [...paneGroups(node.first), ...paneGroups(node.second)];
export function findPaneTab(layout: WorkspaceLayout, id: string) {
  for (const pane of paneGroups(layout.root)) { const tab = pane.tabs.find(item => item.id === id); if (tab) return { pane, tab }; }
}
const equalRef = (a: ResourceRef, b: ResourceRef) => a.kind === b.kind && a.id === b.id;
export function ensurePaneLayout(session: Session, namespace = 'workspace'): WorkspaceLayout {
  if (session.layout) return session.layout;
  const refs = session.openItems.filter(ref => ref.kind !== 'research');
  if (!['research', 'researchView', 'collection'].includes(session.active.kind) && !refs.some(ref => equalRef(ref, session.active as ResourceRef))) refs.push(session.active as ResourceRef);
  const tabs: WorkspaceTab[] = refs.map((ref, index) => ({ id: `view-${namespace}-${index}`, ref: { ...ref },
    ...(session.readers[`main:${ref.id}`] && ref.kind === 'document' ? { reading: { ...session.readers[`main:${ref.id}`] } } : {}),
    ...(equalRef(ref, session.active as ResourceRef) && session.anchor ? { anchor: { ...session.anchor } } : {}),
    ...(session.documentInfoId === ref.id ? { documentInfo: true } : {}),
  }));
  const main: PaneGroup = { kind: 'group', id: `pane-${namespace}-main`, tabs, activeTabId: tabs.find(tab => equalRef(tab.ref, session.active as ResourceRef))?.id ?? tabs[0]?.id };
  const layout: WorkspaceLayout = { root: main, focusedPaneId: main.id };
  const legacy = session.mainSplit;
  if (legacy) {
    const tab: WorkspaceTab = { id: `view-${namespace}-secondary`, ref: { ...legacy.ref }, ...(legacy.anchor ? { anchor: { ...legacy.anchor } } : {}),
      ...(session.readers[`main-secondary:${legacy.ref.id}`] && legacy.ref.kind === 'document' ? { reading: { ...session.readers[`main-secondary:${legacy.ref.id}`] } } : {}),
    };
    if (legacy.open === false) main.tabs.push(tab);
    else {
      const secondary: PaneGroup = { kind: 'group', id: `pane-${namespace}-secondary`, tabs: [tab], activeTabId: tab.id };
      layout.root = { kind: 'split', id: `split-${namespace}-legacy`, axis: legacy.layout === 'horizontal' ? 'row' : 'column', ratio: 0.5, first: main, second: secondary };
    }
  }
  session.layout = layout;
  return layout;
}
export function getReaderPosition(session: Session, documentId: string, target: ReaderTarget): ReadingPosition {
  if (target.startsWith('view:') && session.layout) {
    const tab = findPaneTab(session.layout, target.slice(5))?.tab;
    if (tab?.ref.kind === 'document' && tab.ref.id === documentId) return tab.reading ?? { pageIndex: 0, scale: 1 };
  }
  return session.readers[`${target}:${documentId}`] ?? { pageIndex: 0, scale: 1 };
}
export function replacePane(node: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (node.id === id) return replacement;
  if (node.kind === 'split') { node.first = replacePane(node.first, id, replacement); node.second = replacePane(node.second, id, replacement); }
  return node;
}
export function collapseEmptyPanes(node: PaneNode): PaneNode {
  if (node.kind === 'group') return node;
  node.first = collapseEmptyPanes(node.first); node.second = collapseEmptyPanes(node.second);
  if (node.first.kind === 'group' && !node.first.tabs.length) return node.second;
  if (node.second.kind === 'group' && !node.second.tabs.length) return node.first;
  return node;
}
export function syncPaneSession(session: Session, activate = true) {
  if (!session.layout) return;
  const groups = paneGroups(session.layout.root);
  const focused = groups.find(pane => pane.id === session.layout!.focusedPaneId) ?? groups[0];
  session.layout.focusedPaneId = focused.id;
  if (!groups.some(pane => pane.id === session.layout!.zoomedPaneId)) delete session.layout.zoomedPaneId;
  for (const group of groups) if (!group.tabs.some(tab => tab.id === group.activeTabId)) group.activeTabId = group.tabs[0]?.id;
  const all = groups.flatMap(pane => pane.tabs);
  session.openItems = all.map(tab => tab.ref).filter((ref, index, refs) => refs.findIndex(other => equalRef(other, ref)) === index);
  session.pinnedIds = session.pinnedIds.filter(id => session.openItems.some(ref => ref.id === id));
  const tab = focused.tabs.find(tab => tab.id === focused.activeTabId);
  if (activate && tab) {
    session.active = { ...tab.ref }; session.anchor = tab.anchor; session.documentInfoId = tab.documentInfo && tab.ref.kind === 'document' ? tab.ref.id : undefined;
    if (tab.ref.kind === 'document' && tab.reading) session.readers[`main:${tab.ref.id}`] = { ...tab.reading };
  }
}

export function validatePaneLayout(data: WorkspaceData, key: string) {
  const layout = data.sessions[key].layout;
  if (!layout) return;
  const fail = () => { throw new Error('窗格布局或资源归属损坏，未覆盖现有数据。'); };
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 300;
  const nodes = new Set<string>(), tabs = new Set<string>(); let count = 0;
  function visit(value: unknown, depth = 0) {
    if (!object(value) || !id(value.id) || nodes.has(value.id as string) || depth > 80 || ++count > 1024) return fail();
    nodes.add(value.id as string);
    if (value.kind === 'split') {
      if (!['row', 'column'].includes(value.axis as string) || typeof value.ratio !== 'number' || !Number.isFinite(value.ratio) || value.ratio < 0.1 || value.ratio > 0.9) return fail();
      visit(value.first, depth + 1); visit(value.second, depth + 1); return;
    }
    if (value.kind !== 'group' || !Array.isArray(value.tabs)) return fail();
    for (const tab of value.tabs) {
      if (!object(tab) || !id(tab.id) || tabs.has(tab.id as string) || !object(tab.ref)) return fail();
      tabs.add(tab.id as string);
      const ref = tab.ref as unknown as ResourceRef;
      const entities = ref.kind === 'document' ? data.documents : ref.kind === 'card' ? data.cards : ref.kind === 'board' ? data.boards : ref.kind === 'draft' ? data.drafts : undefined;
      if (typeof ref.id !== 'string' || !entities || !Object.hasOwn(entities, ref.id)) return fail();
      const entity = ref.kind === 'document' ? data.documents[ref.id] : ref.kind === 'card' ? data.cards[ref.id] : ref.kind === 'board' ? data.boards[ref.id] : ref.kind === 'draft' ? data.drafts[ref.id] : undefined;
      const research = data.researches[key];
      if (!entity || key !== 'library' && (!research || (ref.kind === 'document' ? !research.documentIds.includes(ref.id) : ref.kind === 'card' ? !research.cardIds.includes(ref.id) : (entity as { researchId?: string }).researchId !== key))) return fail();
      if (tab.documentInfo !== undefined && typeof tab.documentInfo !== 'boolean') return fail();
      if (tab.reading !== undefined) {
        const pos = tab.reading;
        if (ref.kind !== 'document' || !hasFullText(data.documents[ref.id]) || !object(pos) || !Number.isInteger(pos.pageIndex) || (pos.pageIndex as number) < 0 || (pos.pageIndex as number) >= data.documents[ref.id].pageCount! || typeof pos.scale !== 'number' || !Number.isFinite(pos.scale) || pos.scale < 0.5 || pos.scale > 2 || pos.offset !== undefined && (typeof pos.offset !== 'number' || !Number.isFinite(pos.offset) || pos.offset < 0 || pos.offset > 1)) return fail();
      }
      if (tab.anchor !== undefined) {
        const anchor = tab.anchor;
        if (!object(anchor)) return fail();
        if (anchor.evidenceId !== undefined && (ref.kind !== 'document' || typeof anchor.evidenceId !== 'string' || data.evidence[anchor.evidenceId]?.documentId !== ref.id)) return fail();
        if (anchor.pageIndex !== undefined && (ref.kind !== 'document' || !hasFullText(data.documents[ref.id]) || !Number.isInteger(anchor.pageIndex) || (anchor.pageIndex as number) < 0 || (anchor.pageIndex as number) >= data.documents[ref.id].pageCount!)) return fail();
        if (anchor.placementId !== undefined) {
          if (typeof anchor.placementId !== 'string') return fail();
          const placement = data.placements[anchor.placementId];
          // Removing a placement keeps its resource; discard only the obsolete navigation hint.
          if (!placement) delete anchor.placementId;
          else if (ref.kind === 'board' ? placement.boardId !== ref.id : !equalRef(placement.resourceRef, ref) || key !== 'library' && data.boards[placement.boardId]?.researchId !== key) return fail();
        }
      }
    }
    if (value.tabs.length ? !value.tabs.some(tab => tab.id === value.activeTabId) : value.activeTabId !== undefined) return fail();
  }
  if (!object(layout)) return fail();
  visit(layout.root);
  const groups = paneGroups(layout.root);
  if (!groups.some(group => group.id === layout.focusedPaneId) || layout.zoomedPaneId !== undefined && !groups.some(group => group.id === layout.zoomedPaneId)) return fail();
}
