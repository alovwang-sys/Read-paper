import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  newElementWith,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawEmbeddableElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types';
import { ArrowUpRight, FileText, MessageCircle, Pencil, RotateCw, StickyNote } from 'lucide-react';
import type { DrawingScene } from '../../domain/drawing';
import type { BoardDrawingRef, BoardEdge, BoardPlacement, BoardViewport } from '../../domain/types';
import { promoteRemovedPlacements } from '../../domain/board-structure';
import {
  flushBoardDrawings,
  getDrawingSaveState,
  loadBoardDrawing,
  stageBoardDrawing,
  subscribeDrawingSaves,
} from '../../services/drawing-storage';
import { resourceExists, resourceTitle, uid, useWorkspace } from '../../services/workspace';
import { attachDrawingQuestion, openDrawingConversation } from '../../services/drawing-question';
import { BoardQuestionDialog, type DrawingQuestionSource } from './BoardQuestionDialog';
import { BoardResearchActions } from './BoardResearchActions';
import { drawingResearchSelection } from './board-research-selection';
import { captureDrawingQuestion } from './drawing-question-capture';
import { bindDroppedArrowEndpoints, moveBoundArrowEndpoints } from './drawing-bindings';
import { hasFullText } from '../../domain/knowledge';
import { findPaneTab } from '../../services/panes';
import '@excalidraw/excalidraw/index.css';
import './drawing.css';

const refKey = (ref?: BoardDrawingRef) => ref ? `${ref.assetId}:${ref.hash}` : '';
const resourceKey = (item: BoardPlacement['resourceRef']) => `${item.kind}:${item.id}`;
const resourceLink = (id: string) => `papertrail://placement/${encodeURIComponent(id)}`;
const placementId = (element: ExcalidrawElement) => element.type === 'embeddable' && typeof element.customData?.placementId === 'string' ? element.customData.placementId as string : undefined;
const sceneSignature = (elements: readonly ExcalidrawElement[], background: string, files: BinaryFiles) => JSON.stringify([elements, background, files]);

function drawingViewport(value: unknown): BoardViewport | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const view = JSON.parse(value) as BoardViewport;
    return [view?.x, view?.y, view?.scale].every(Number.isFinite) && view.scale > 0 ? view : undefined;
  } catch { return undefined; }
}

const editors = new Map<string, { token: symbol; mounted: boolean }>();
const editorListeners = new Set<() => void>();

async function releaseClosedEditor(boardId: string) {
  const editor = editors.get(boardId);
  if (!editor || editor.mounted) return;
  await flushBoardDrawings(boardId);
  if (editors.get(boardId) === editor && !editor.mounted) {
    editors.delete(boardId);
    editorListeners.forEach(listener => listener());
  }
}

function resourceElement(item: BoardPlacement) {
  const shape = convertToExcalidrawElements([{
    type: 'rectangle', id: `resource-${item.id}`, x: item.x, y: item.y,
    width: 260, height: 220, strokeColor: '#ccd9c4', backgroundColor: '#fffefa',
    fillStyle: 'solid', strokeWidth: 1, roughness: 0,
    link: resourceLink(item.id), customData: { placementId: item.id, resourceRef: item.resourceRef },
  }], { regenerateIds: false })[0];
  return { ...shape, type: 'embeddable' as const };
}

/** Map copies of a history scene back to their newly allocated placement IDs. */
function syncResources(elements: readonly ExcalidrawElement[], placements: BoardPlacement[], remap = false) {
  const used = new Set<string>();
  const next = elements.map(element => {
    const id = placementId(element);
    if (!id) return element;
    let item = placements.find(placement => placement.id === id && !used.has(placement.id));
    if (!item && remap && element.customData?.resourceRef) item = placements.find(placement => !used.has(placement.id) && resourceKey(placement.resourceRef) === resourceKey(element.customData!.resourceRef));
    if (!item) return element.isDeleted ? element : newElementWith(element, { isDeleted: true });
    used.add(item.id);
    const metadata = element.customData?.resourceRef;
    if (!element.isDeleted && element.x === item.x && element.y === item.y && id === item.id && metadata && resourceKey(metadata) === resourceKey(item.resourceRef)) return element;
    return newElementWith(element, {
      x: item.x, y: item.y, isDeleted: false, link: resourceLink(item.id),
      customData: { ...element.customData, placementId: item.id, resourceRef: item.resourceRef },
    });
  });
  for (const item of placements) if (!used.has(item.id)) next.push(resourceElement(item));
  return moveBoundArrowEndpoints(elements, next);
}

function syncEdges(elements: readonly ExcalidrawElement[], edges: BoardEdge[]) {
  const resources = new Map(elements.filter(element => !element.isDeleted && placementId(element)).map(element => [placementId(element), element]));
  const semantic = convertToExcalidrawElements(edges.flatMap(edge => {
    const from = resources.get(edge.fromPlacementId), to = resources.get(edge.toPlacementId);
    if (!from || !to) return [];
    const x = from.x + from.width / 2, y = from.y + from.height / 2;
    return [{
      type: 'arrow' as const, id: `relation-${edge.id}`, x, y,
      points: [[0, 0], [to.x + to.width / 2 - x, to.y + to.height / 2 - y]],
      strokeColor: '#8b9e80', strokeWidth: 1, roughness: 0, locked: true,
      label: { id: `relation-label-${edge.id}`, text: edge.label, fontSize: 12, fontFamily: 2 },
      customData: { boardEdgeId: edge.id },
    }];
  }), { regenerateIds: false });
  const semanticIds = new Set(semantic.map(element => element.id));
  const old = new Map(elements.map(element => [element.id, element]));
  const generated = semantic.map(element => {
    const previous = old.get(element.id);
    const customData = { ...element.customData, boardRelation: true };
    if (previous && !previous.isDeleted && previous.x === element.x && previous.y === element.y && previous.width === element.width && previous.height === element.height && (previous.type !== 'arrow' || (element.type === 'arrow' && JSON.stringify(previous.points) === JSON.stringify(element.points))) && (previous.type !== 'text' || (element.type === 'text' && previous.text === element.text))) return previous;
    return previous ? newElementWith(previous, {
      x: element.x, y: element.y, width: element.width, height: element.height,
      customData, locked: true, isDeleted: false,
      ...(previous.type === 'arrow' && element.type === 'arrow' ? { points: element.points } : {}),
      ...(previous.type === 'text' && element.type === 'text' ? { text: element.text, originalText: element.originalText } : {}),
    }) : { ...element, customData, locked: true };
  });
  return [
    ...generated,
    ...elements.filter(element => !semanticIds.has(element.id)).map(element => element.customData?.boardRelation && !element.isDeleted ? newElementWith(element, { isDeleted: true }) : element),
  ];
}

export default function BoardDrawing({ boardId, onViewport }: { boardId: string; onViewport?: (position: { x: number; y: number }) => void }) {
  const { data, actions, pane, view } = useWorkspace();
  const board = data.boards[boardId];
  const [initial, setInitial] = useState<{ key: number; scene: ExcalidrawInitialDataState }>();
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [drawingQuestionError, setDrawingQuestionError] = useState('');
  const [drawingQuestionBusy, setDrawingQuestionBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [researchSelection, setResearchSelection] = useState<ReturnType<typeof drawingResearchSelection> & { left: number; top: number }>({ placementIds: [], texts: [], elementIds: [], unsupportedCount: 0, left: 12, top: 12 });
  const [questionSource, setQuestionSource] = useState<DrawingQuestionSource>();
  const [questionOpen, setQuestionOpen] = useState(false);
  const questionPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const researchSelectionKey = useRef('');
  const [save, setSave] = useState(() => getDrawingSaveState(boardId));
  const [hasEditLock, setHasEditLock] = useState(false);
  const [editorReady, setEditorReady] = useState(false);
  const editorToken = useRef(Symbol('drawing-editor'));
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const acceptedRef = useRef<BoardDrawingRef | undefined>(board?.drawing);
  const loadedRef = useRef<string | undefined>(undefined);
  const loadAttempt = useRef(-1);
  const initialized = useRef(false);
  const lastSignature = useRef('');
  const stageVersion = useRef(0);
  const generation = useRef(0);
  const snapshots = useRef(new Map<string, BoardPlacement>());
  const removedEdges = useRef(new Map<string, BoardEdge>());
  const removedStructure = useRef(new Map<string, { before: BoardPlacement; after: BoardPlacement }>());
  const selectedKey = useRef('');
  const viewportTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingViewport = useRef<{ x: number; y: number; scale: number } | undefined>(undefined);
  const viewportKey = `drawing:${boardId}`;
  const paneViewport = useRef<BoardViewport | undefined>(undefined);
  paneViewport.current = drawingViewport(view?.viewState?.[viewportKey]);
  const structure = JSON.stringify([
    Object.values(data.placements).filter(item => item.boardId === boardId),
    Object.values(data.edges).filter(item => item.boardId === boardId),
  ]);

  useEffect(() => {
    const token = editorToken.current;
    const claim = () => {
      if (!editors.has(boardId)) {
        editors.set(boardId, { token, mounted: true });
        // A waiting view must reload the previous writer's final scene before editing.
        if (loadedRef.current !== undefined) { setEditorReady(false); setRetry(value => value + 1); }
      }
      setHasEditLock(editors.get(boardId)?.token === token);
    };
    editorListeners.add(claim);
    claim();
    return () => {
      editorListeners.delete(claim);
      const editor = editors.get(boardId);
      if (editor?.token === token) {
        editor.mounted = false;
        void releaseClosedEditor(boardId).catch(() => undefined);
      }
    };
  }, [boardId]);

  const rememberViewport = useCallback(() => {
    clearTimeout(viewportTimer.current);
    const view = pendingViewport.current;
    pendingViewport.current = undefined;
    const current = actions.getState().data;
    const currentBoard = current.boards[boardId];
    if (!view || !currentBoard || !current.sessions[currentBoard.researchId]) return;
    const previous = paneViewport.current ?? current.sessions[currentBoard.researchId].viewports[viewportKey];
    if (previous?.x === view.x && previous?.y === view.y && previous?.scale === view.scale) return;
    if (pane) actions.setViewState({ [viewportKey]: JSON.stringify(view) });
    else actions.updateData(next => { next.sessions[currentBoard.researchId].viewports[viewportKey] = view; });
  }, [actions, boardId, viewportKey, pane?.tabId]);

  useEffect(() => {
    const update = () => setSave(getDrawingSaveState(boardId));
    update();
    return subscribeDrawingSaves(update);
  }, [boardId]);

  useEffect(() => {
    return () => {
      try { rememberViewport(); } catch { /* The shared workspace keeps its own save error visible. */ }
      void flushBoardDrawings(boardId).catch(() => undefined);
    };
  }, [boardId, rememberViewport]);

  useEffect(() => {
    if (!board) return;
    const key = refKey(board.drawing);
    if (loadedRef.current !== undefined && key === refKey(acceptedRef.current) && loadAttempt.current === retry) return;
    loadAttempt.current = retry;
    const currentGeneration = ++generation.current;
    stageVersion.current++;
    initialized.current = false;
    setEditorReady(false);
    api.current = null;
    setInitial(undefined);
    setLoadError('');
    setError('');
    setDrawingQuestionError('');
    setSelected([]);
    setResearchSelection({ placementIds: [], texts: [], elementIds: [], unsupportedCount: 0, left: 12, top: 12 });
    setQuestionOpen(false);
    researchSelectionKey.current = '';
    selectedKey.current = '';
    acceptedRef.current = board.drawing;
    snapshots.current.clear();
    removedEdges.current.clear();
    removedStructure.current.clear();
    let cancelled = false;
    void loadBoardDrawing(boardId, board.drawing).then(saved => {
      if (cancelled) return;
      const current = actions.getState().data;
      const placements = Object.values(current.placements).filter(item => item.boardId === boardId);
      const edges = Object.values(current.edges).filter(item => item.boardId === boardId);
      placements.forEach(item => snapshots.current.set(item.id, item));
      const elements = syncEdges(syncResources(restoreElements(saved?.elements ?? [], null), placements, true), edges);
      const view = paneViewport.current ?? current.sessions[board.researchId]?.viewports[viewportKey];
      loadedRef.current = key;
      setInitial({ key: currentGeneration, scene: {
        elements,
        files: saved?.files ?? {},
        appState: {
          ...saved?.appState, viewBackgroundColor: saved?.appState.viewBackgroundColor ?? '#f7f8f4',
          scrollX: view?.x ?? saved?.appState.scrollX ?? 0,
          scrollY: view?.y ?? saved?.appState.scrollY ?? 0,
          zoom: { value: view?.scale ?? saved?.appState.zoom.value ?? 1 } as AppState['zoom'],
        },
      } });
    }).catch(problem => { if (!cancelled) setLoadError(problem instanceof Error ? problem.message : '绘图加载失败，请重试。'); });
    return () => { cancelled = true; };
  }, [boardId, board?.drawing?.assetId, board?.drawing?.hash, retry, actions, viewportKey]);

  useEffect(() => {
    if (!api.current || !initialized.current) return;
    const [placements, edges] = JSON.parse(structure) as [BoardPlacement[], BoardEdge[]];
    placements.forEach(item => snapshots.current.set(item.id, item));
    const elements = api.current.getSceneElementsIncludingDeleted();
    const next = syncEdges(syncResources(elements, placements), edges);
    if (JSON.stringify(next) !== JSON.stringify(elements)) api.current.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
  }, [structure, initial]);

  const anchorPlacementId = (view?.anchor ?? (board && data.sessions[board.researchId]?.anchor))?.placementId;
  useEffect(() => {
    const id = anchorPlacementId;
    if (!board || !id || !api.current || !initialized.current) return;
    const element = api.current.getSceneElements().find(item => placementId(item) === id);
    if (!element) return;
    actions.updateData(next => {
      const owner = next.sessions[board.researchId];
      const tab = pane && owner.layout ? findPaneTab(owner.layout, pane.tabId)?.tab : undefined;
      if (tab?.anchor?.placementId === id) tab.anchor = undefined;
      if (owner.anchor?.placementId === id) owner.anchor = undefined;
    });
    api.current.scrollToContent([element], { fitToContent: false, animate: false });
    api.current.updateScene({ appState: { selectedElementIds: { [element.id]: true } }, captureUpdate: CaptureUpdateAction.NEVER });
  }, [boardId, anchorPlacementId, initial, structure, actions, pane?.tabId]);

  function open(item: BoardPlacement, target: 'main' | 'inspector' = 'inspector', source = false) {
    try {
      const current = actions.getState().data;
      const currentBoard = current.boards[boardId];
      if (!currentBoard) return;
      const scope = { kind: 'research' as const, researchId: currentBoard.researchId };
      if (source && item.resourceRef.kind === 'card') {
        const evidence = current.evidence[current.cards[item.resourceRef.id]?.evidenceIds[0]];
        if (!evidence || !current.documents[evidence.documentId]) throw new Error('这张卡片的原文来源已缺失，请在卡片中修复引用。');
        actions.openResource({ kind: 'document', id: evidence.documentId }, { scope, target, anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex } });
      } else actions.openResource(item.resourceRef, { scope, target, anchor: { placementId: item.id } });
      setError('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : '打开资料失败，请重试。'); }
  }

  function change(elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) {
    const allowed = elements.filter(element => element.type !== 'iframe' && (element.type !== 'embeddable' || snapshots.current.has(placementId(element) ?? '')));
    if (allowed.length !== elements.length) {
      setError('白板仅允许当前研究资料，不支持外部网页嵌入。');
      api.current?.updateScene({ elements: allowed, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const centre = viewportCoordsToSceneCoords({ clientX: state.offsetLeft + state.width / 2, clientY: state.offsetTop + state.height / 2 }, state);
    onViewport?.({ x: Math.max(20, centre.x - 130), y: Math.max(55, centre.y - 110) });
    const research = drawingResearchSelection(elements, state, [...snapshots.current.values()]);
    const selectedElements = elements.filter(element => research.elementIds.includes(element.id));
    const left = Math.min(...selectedElements.map(element => element.x));
    const top = Math.min(...selectedElements.map(element => element.y));
    const point = selectedElements.length ? sceneCoordsToViewportCoords({ sceneX: left, sceneY: top }, state) : { x: state.offsetLeft + 12, y: state.offsetTop + 12 };
    const localSelection = { ...research, left: Math.max(12, Math.min(point.x - state.offsetLeft, Math.max(12, state.width - 280))), top: Math.max(76, point.y - state.offsetTop - 45) };
    const localKey = JSON.stringify(localSelection);
    if (localKey !== researchSelectionKey.current) { researchSelectionKey.current = localKey; setResearchSelection(localSelection); }
    const ids = research.placementIds;
    const selection = ids.join(',');
    if (selection !== selectedKey.current) {
      selectedKey.current = selection;
      setSelected(ids);
      const current = actions.getState().data;
      const currentBoard = current.boards[boardId];
      if (currentBoard) actions.setSelection({
        scope: { kind: 'research', researchId: currentBoard.researchId }, viewInstanceId: pane ? `view:${pane.tabId}` : `board:${boardId}`,
        selectedItems: ids.map(id => ({ resourceRef: snapshots.current.get(id)!.resourceRef, placementId: id })),
        evidenceIds: [...new Set(ids.flatMap(id => {
          const ref = snapshots.current.get(id)!.resourceRef;
          return ref.kind === 'card' ? current.cards[ref.id]?.evidenceIds ?? [] : [];
        }))],
      });
    }
    const signature = sceneSignature(elements, state.viewBackgroundColor, files);
    if (!initialized.current) {
      initialized.current = true;
      lastSignature.current = signature;
      setEditorReady(true);
      return;
    }
    const view = { x: state.scrollX, y: state.scrollY, scale: state.zoom.value };
    const previousView = pendingViewport.current ?? paneViewport.current ?? actions.getState().data.sessions[board?.researchId ?? '']?.viewports[viewportKey];
    if (previousView?.x !== view.x || previousView?.y !== view.y || previousView?.scale !== view.scale) {
      pendingViewport.current = view;
      clearTimeout(viewportTimer.current);
      viewportTimer.current = setTimeout(() => {
        try { rememberViewport(); } catch (problem) { setError(problem instanceof Error ? problem.message : '视口保存失败。'); }
      }, 250);
    }
    if (signature === lastSignature.current) return;
    if (!editorReady || editors.get(boardId)?.token !== editorToken.current || !editors.get(boardId)?.mounted) return;
    lastSignature.current = signature;
    const version = ++stageVersion.current;
    const baseline = acceptedRef.current;
    const saveGeneration = generation.current;
    const snapshot = new Map(snapshots.current);
    const scene: DrawingScene = {
      type: 'excalidraw', version: 2, source: 'Papertrail', elements: structuredClone(elements),
      appState: { viewBackgroundColor: state.viewBackgroundColor, scrollX: state.scrollX, scrollY: state.scrollY, zoom: { value: state.zoom.value } },
      files: structuredClone(files),
    };
    stageBoardDrawing(boardId, scene, nextRef => {
      if (version !== stageVersion.current) throw new Error('白板绘图已切换版本，当前恢复缓冲已保留；请重新打开后重试。');
      const current = actions.getState().data;
      const currentBoard = current.boards[boardId];
      if (!currentBoard || !current.researches[currentBoard.researchId]) return;
      if (saveGeneration !== generation.current || refKey(currentBoard.drawing) !== refKey(acceptedRef.current)) throw new Error('白板版本已改变，未覆盖新版本；请重新打开绘图后重试。');
      const byPlacement = new Map(scene.elements.filter(element => placementId(element)).map(element => [placementId(element)!, element]));
      acceptedRef.current = nextRef;
      try {
        actions.updateData(next => {
          next.boards[boardId].drawing = nextRef;
          const structureBefore = Object.values(next.placements).filter(item => item.boardId === boardId);
          const deleted = new Set<string>();
          let restored = false;
          for (const [id, element] of byPlacement) {
            const previous = snapshot.get(id);
            if (!previous || previous.boardId !== boardId) continue;
            const currentPlacement = next.placements[id];
            if (currentPlacement && (resourceKey(currentPlacement.resourceRef) !== resourceKey(previous.resourceRef) || currentPlacement.x !== previous.x || currentPlacement.y !== previous.y)) continue;
            if (element.isDeleted) {
              if (currentPlacement) deleted.add(id);
              delete next.placements[id];
              for (const edge of Object.values(next.edges)) if (edge.boardId === boardId && (edge.fromPlacementId === id || edge.toPlacementId === id)) {
                removedEdges.current.set(edge.id, edge);
                delete next.edges[edge.id];
              }
            } else if (resourceExists(next, previous.resourceRef)) {
              if (!currentPlacement) restored = true;
              next.placements[id] = { ...(next.placements[id] ?? previous), x: element.x, y: element.y };
            }
          }
          if (deleted.size && structureBefore.some(item => item.order !== undefined || item.parentPlacementId !== undefined)) {
            for (const promoted of promoteRemovedPlacements(structureBefore, deleted)) {
              const before = structureBefore.find(item => item.id === promoted.id)!;
              if (before.parentPlacementId === promoted.parentPlacementId && before.order === promoted.order) continue;
              removedStructure.current.set(promoted.id, { before: removedStructure.current.get(promoted.id)?.before ?? { ...before }, after: promoted });
              Object.assign(next.placements[promoted.id], { order: promoted.order, parentPlacementId: promoted.parentPlacementId });
            }
          }
          if (restored) for (const [id, change] of removedStructure.current) {
            const current = next.placements[id];
            if (current && current.parentPlacementId === change.after.parentPlacementId && current.order === change.after.order && (!change.before.parentPlacementId || next.placements[change.before.parentPlacementId])) {
              Object.assign(current, { order: change.before.order, parentPlacementId: change.before.parentPlacementId });
              removedStructure.current.delete(id);
            }
          }
          for (const edge of removedEdges.current.values()) if (next.placements[edge.fromPlacementId] && next.placements[edge.toPlacementId] && !next.edges[edge.id]) {
            next.edges[edge.id] = edge;
            removedEdges.current.delete(edge.id);
          }
        }, { boardChange: { summary: '编辑白板绘图' } });
      } catch (problem) { acceptedRef.current = baseline; throw problem; }
    }, baseline);
  }

  async function askDrawing() {
    const editor = api.current;
    if (!editor || drawingQuestionBusy) return;
    setDrawingQuestionError('');
    setDrawingQuestionBusy(true);
    try {
      const current = actions.getState().data;
      const currentBoard = current.boards[boardId];
      if (!currentBoard) throw new Error('白板已不存在，请重新打开。');
      const conversationId = openDrawingConversation(currentBoard.researchId, boardId, researchSelection);
      const workspaceGeneration = actions.getGeneration();
      const capture = await captureDrawingQuestion(
        editor.getSceneElements(), editor.getAppState(), editor.getFiles(),
        Object.values(current.placements).filter(item => item.boardId === boardId), current,
      );
      await attachDrawingQuestion(currentBoard.researchId, boardId, {
        ...capture, conversationId, generation: workspaceGeneration,
      });
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.research-conversation-host .research-agent-input')?.focus());
    } catch (problem) {
      setDrawingQuestionError(problem instanceof Error ? problem.message : '选区图片准备失败，请重试。');
    } finally { setDrawingQuestionBusy(false); }
  }

  // shortcut: native PNG/SVG exports omit live resource text; render previews to images if full-board image export is needed.
  function renderResource(element: ExcalidrawEmbeddableElement) {
    const id = placementId(element);
    const item = id ? snapshots.current.get(id) : undefined;
    if (!item) return <div className="drawing-resource drawing-resource-missing">资料摆放已缺失</div>;
    const exists = resourceExists(data, item.resourceRef);
    const card = item.resourceRef.kind === 'card' ? data.cards[item.resourceRef.id] : undefined;
    const document = item.resourceRef.kind === 'document' ? data.documents[item.resourceRef.id] : undefined;
    return <article className={`drawing-resource ${document ? 'is-document' : ''}`} aria-label={`白板资料：${resourceTitle(data, item.resourceRef)}`} onDoubleClick={() => open(item)}>
      <div className="drawing-resource-kind">{document ? <FileText size={14} /> : <StickyNote size={14} />}{document ? hasFullText(document) ? 'PDF 论文' : '文献条目' : '观点卡片'}{item.group && <span>{item.group}</span>}</div>
      <h3>{resourceTitle(data, item.resourceRef)}</h3>
      {exists ? <p>{card?.body || (document ? `${document.authors}${document.year ? ` · ${document.year}` : ''}\n${hasFullText(document) ? `${document.pageCount} 页` : '全文未导入'}` : '')}</p> : <p className="drawing-resource-missing">资料已缺失，请移出此摆放或修复来源。</p>}
      <footer><span>{card ? `${card.evidenceIds.length} 条原文依据` : hasFullText(document) ? '原文与引用保留在资料库' : '题录与摘要 · 全文未导入'}</span><button onClick={() => open(item)} aria-label={`在右侧打开：${resourceTitle(data, item.resourceRef)}`}>打开 <ArrowUpRight size={13} /></button></footer>
    </article>;
  }

  if (loadError) return <div className="empty-state" role="alert"><h2>暂时无法打开绘图</h2><p>{loadError}</p><button className="button" onClick={() => setRetry(value => value + 1)}><RotateCw size={14} />重试加载</button></div>;
  if (!initial || !board) return <div className="empty-state" role="status">正在加载白板绘图…</div>;
  const active = selected.length === 1 ? snapshots.current.get(selected[0]) : undefined;
  const editable = hasEditLock && editorReady;
  return <div className="board-drawing" aria-label="白板自由绘图" data-editable={editable}>
    {!hasEditLock && <div className="drawing-readonly" role="status">{editors.get(boardId)?.mounted ? '此白板正在另一窗格编辑；关闭该绘图视图后可在此编辑。' : '正在等待上一窗格保存；保存完成后自动接管。'}当前视图可独立平移与缩放。</div>}
    <div className="board-drawing-canvas" onDropCapture={event => {
      if ([...event.dataTransfer.files].some(file => /\.(excalidraw|json)$/i.test(file.name))) {
        event.preventDefault();
        event.stopPropagation();
        setError('请通过工作区备份恢复绘图；此处可拖入图片。');
      }
    }}>
      <Excalidraw key={initial.key} name={board.title} langCode="zh-CN" theme="light" aiEnabled={false} initialData={initial.scene}
        viewModeEnabled={!editable}
        excalidrawAPI={value => { api.current = value; }} onChange={change} handleKeyboardGlobally={false}
        onPointerUp={(_tool, gesture) => {
          const editor = api.current;
          if (!editor || gesture.withCmdOrCtrl || !editor.getAppState().isBindingEnabled) return;
          requestAnimationFrame(() => {
            if (api.current !== editor) return;
            const elements = editor.getSceneElementsIncludingDeleted();
            const moved = moveBoundArrowEndpoints([...gesture.originalElements.values()], elements);
            const next = bindDroppedArrowEndpoints(moved, gesture.originalElements);
            if (next !== elements) editor.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
          });
        }}
        UIOptions={{ canvasActions: { loadScene: false } }}
        onPaste={clipboard => {
          if (clipboard.elements?.some(element => element.type === 'iframe' || (element.type === 'embeddable' && !snapshots.current.has(placementId(element) ?? '')))) {
            setError('白板不支持粘贴外部网页嵌入。');
            return false;
          }
          return true;
        }}
        validateEmbeddable={link => [...snapshots.current.keys()].some(id => resourceLink(id) === link)}
        renderEmbeddable={renderResource}
        onLinkOpen={(_element, event) => event.preventDefault()}
        onDuplicate={(next, previous) => {
          const known = new Set(previous.map(element => element.id));
          return next.map(element => {
            const id = placementId(element), item = id ? snapshots.current.get(id) : undefined;
            if (known.has(element.id) || !item) return element;
            const copy = { ...item, id: uid('placement'), x: element.x, y: element.y };
            snapshots.current.set(copy.id, copy);
            return newElementWith(element, { link: resourceLink(copy.id), customData: { ...element.customData, placementId: copy.id, resourceRef: copy.resourceRef } });
          });
        }}>
        <MainMenu>
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.DefaultItems.ClearCanvas />
        </MainMenu>
      </Excalidraw>
    </div>
    {data.agentWorkbench !== false && researchSelection.elementIds.length > 0 ? <div className="drawing-local-research drawing-agent-action" style={{ left: researchSelection.left, top: researchSelection.top }} onPointerDown={event => event.stopPropagation()}>
      <button className="button" disabled={drawingQuestionBusy} onClick={() => void askDrawing()}><MessageCircle size={14} />{drawingQuestionBusy ? '正在准备选区…' : '问 Agent'}</button>
      <small>{researchSelection.elementIds.length === 1 && researchSelection.placementIds.length === 1 ? '进入这张卡片的讨论' : `${researchSelection.elementIds.length} 个元素 · 进入本白板讨论`}</small>
    </div> : data.agentWorkbench === false && (researchSelection.placementIds.length > 0 || researchSelection.texts.length > 0) && <div className="drawing-local-research" style={{ left: researchSelection.left, top: researchSelection.top }} onPointerDown={event => event.stopPropagation()}>
      {researchSelection.placementIds.length > 0 && <BoardResearchActions boardId={boardId} placementIds={researchSelection.placementIds} />}
      {researchSelection.texts.length > 0 && <button className="button" onClick={() => {
        const source = { elementIds: researchSelection.texts.map(item => item.id), text: researchSelection.texts.map(item => item.text).join('\n\n') };
        setQuestionSource(source);
        const element = api.current?.getSceneElements().find(item => item.id === source.elementIds[0]);
        questionPosition.current = element ? { x: Math.max(20, element.x), y: Math.max(55, element.y + element.height + 35) } : undefined;
        setQuestionOpen(true);
      }}><Pencil size={14} />文字作为问题{researchSelection.texts.length > 1 ? ` · ${researchSelection.texts.length} 项` : ''}</button>}
      {researchSelection.texts.length > 0 && researchSelection.placementIds.length > 0 && <small>绘图文字先核对并转为问题，不自动并入所选资料。</small>}
    </div>}
    {drawingQuestionError && <div className="board-message has-error drawing-question-message" role="alert"><span>{drawingQuestionError}</span><button className="button" onClick={() => setDrawingQuestionError('')}>关闭</button></div>}
    {(error || save.status === 'error') && <div className="board-message has-error" role="alert"><span>{error || save.error}</span><button className="button" onClick={() => { setError(''); void flushBoardDrawings(boardId).then(() => releaseClosedEditor(boardId)).catch(problem => setError(problem instanceof Error ? problem.message : '保存失败，请重试。')); }}>重试保存</button></div>}
    <div className="drawing-statusbar">
      {active ? <div className="drawing-resource-actions"><span>{resourceTitle(data, active.resourceRef)}</span><button className="button" onClick={() => open(active)}>右侧打开</button><button className="button" onClick={() => open(active, 'main')}>主区打开</button>{active.resourceRef.kind === 'card' && <button className="button" onClick={() => open(active, 'inspector', true)}>查看原文</button>}</div> : <span>{data.agentWorkbench !== false ? '框选图形、文字、笔迹、图片或资料，问 Agent 继续研究。' : researchSelection.unsupportedCount > 0 ? '图形、图片和笔迹不自动识别为问题；可用上方“写问题”补充。' : researchSelection.placementIds.length > 1 ? `已选 ${researchSelection.placementIds.length} 项资料，可核对后继续研究。` : '画笔、形状、文字和箭头可直接绘制；选择资料后可继续研究。'}</span>}
      <span className={`drawing-save-status is-${save.status}`} role="status">{({ dirty: '绘图待保存', saving: '正在保存绘图…', saved: '绘图已保存', error: '绘图保存失败' })[save.status]}</span>
    </div>
    <BoardQuestionDialog boardId={boardId} open={questionOpen} onClose={() => setQuestionOpen(false)} drawingOrigin={questionSource} position={questionPosition.current} onCreated={id => {
      setSelected([id]);
      const item = actions.getState().data.placements[id];
      if (item) requestAnimationFrame(() => { const element = api.current?.getSceneElements().find(value => placementId(value) === id); if (element) api.current?.scrollToContent([element], { fitToContent: false, animate: true }); });
    }} />
  </div>;
}
