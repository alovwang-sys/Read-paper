import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowUpRight,
  FileText,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListTree,
  Target,
  Grip,
  Hand,
  History,
  Link2,
  MousePointer2,
  Pencil,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { BoardEdge, BoardPlacement } from '../../domain/types';
import { hasFullText } from '../../domain/knowledge';
import { findPaneTab } from '../../services/panes';
import {
  resourceExists,
  resourceTitle,
  getActiveConversation,
  uid,
  usePaneViewState,
  useWorkspace,
} from '../../services/workspace';
import { BoardHistoryPanel } from '../ai/BoardProposal';
import { BoardConnections, useBoardNodeSizes } from './BoardConnections';
import { BoardLayoutPreview, BoardOutline } from './BoardOutline';
import { boardDescendants } from '../../domain/board-structure';
import { layoutBoardTree } from '../../domain/board-layout';
import { addBoardCard, moveBoardBranch, removeBoardPlacements, reorderBoardPlacement, setBoardLayout } from '../../services/board-structure';
import { BoardQuestionDialog } from './BoardQuestionDialog';
import { BoardResearchActions } from './BoardResearchActions';
import './board.css';

const BoardDrawing = lazy(() => import('./BoardDrawing'));

type Undo = { placements: BoardPlacement[]; edges: BoardEdge[]; revision: number };
const recentRemovals = new Map<string, Undo>();
function stringIds(value: string): string[] {
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}
type PlacementPosition = Pick<BoardPlacement, 'id' | 'x' | 'y'>;

function movedPositions(items: PlacementPosition[], dx: number, dy: number) {
  const x = Math.max(20 - Math.min(...items.map(item => item.x)), Math.round(dx));
  const y = Math.max(55 - Math.min(...items.map(item => item.y)), Math.round(dy));
  return Object.fromEntries(
    items.map(item => [item.id, { x: item.x + x, y: item.y + y }]),
  );
}

export function BoardView({ boardId }: { boardId: string }) {
  const { data, actions, session, pane, view } = useWorkspace();
  const domId = useId();
  const board = data.boards[boardId];
  const tree = board?.layout === 'tree';
  const canvasDefaults = useRef<Record<string, 'draw' | 'organize'>>({});
  const canvasDefault = canvasDefaults.current[boardId] ??= session.boardModes?.[boardId] ?? (board?.drawing ? 'draw' : 'organize');
  const [canvasMode, setCanvasMode] = usePaneViewState<'draw' | 'organize'>(`board:${boardId}:canvas`, canvasDefault);
  const drawingMode = canvasMode === 'draw';
  const boardRevision = data.boardRevisions?.[boardId] ?? 0;
  const [mode, setMode] = usePaneViewState<'select' | 'connect' | 'pan'>(`board:${boardId}:mode`, 'select');
  const [selectedJSON, setSelectedJSON] = usePaneViewState<string>(`board:${boardId}:selected`, '[]');
  const [freeSelection, setFreeSelection] = useState<string[]>([]);
  const selected = tree ? stringIds(selectedJSON) : freeSelection;
  const setSelected = (ids: string[]) => tree ? setSelectedJSON(JSON.stringify(ids)) : setFreeSelection(ids);
  const [collapsedJSON, setCollapsedJSON] = usePaneViewState<string>(`board:${boardId}:collapsed`, '[]');
  const collapsed = stringIds(collapsedJSON);
  const [outlineOpen, setOutlineOpen] = usePaneViewState<boolean>(`board:${boardId}:outline`, false);
  const [summary, setSummary] = usePaneViewState<boolean>(`board:${boardId}:summary`, false);
  const [showRelations, setShowRelations] = usePaneViewState<boolean>(`board:${boardId}:relations`, false);
  const [layoutPreview, setLayoutPreview] = useState<number>();
  const [sourcePicker, setSourcePicker] = useState<BoardPlacement>();
  const [removeBranch, setRemoveBranch] = useState<string>();
  const [connectingFrom, setConnectingFrom] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [questionPosition, setQuestionPosition] = useState<{ x: number; y: number }>();
  const drawingPosition = useRef<{ x: number; y: number } | undefined>(undefined);
  const [pickerKind, setPickerKind] = useState<'card' | 'document'>('card');
  const [query, setQuery] = usePaneViewState<string>(`board:${boardId}:query`, '');
  const [pickerQuery, setPickerQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Undo | undefined>(() =>
    recentRemovals.get(boardId),
  );
  const [preview, setPreview] = useState<Record<string, { x: number; y: number }>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLElement | null>>({});
  const gesture = useRef<
    | {
        kind: 'move';
        items: PlacementPosition[];
        startX: number;
        startY: number;
        scale: number;
        moved: boolean;
      }
    | { kind: 'pan'; startX: number; startY: number; x: number; y: number }
    | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const scale = actions.getBoardViewport(boardId).scale;
  const placements = Object.values(data.placements).filter(
    (item) => item.boardId === boardId,
  );
  const edges = Object.values(data.edges).filter(
    (item) => item.boardId === boardId,
  );
  const activePlacements = placements.filter((item) =>
    selected.includes(item.id),
  );
  const edge = selectedEdge && data.edges[selectedEdge];
  const scope = {
    kind: 'research' as const,
    researchId: board?.researchId ?? '',
  };
  const visiblePlacements = tree ? layoutBoardTree(placements, { collapsedIds: collapsed, nodeHeight: summary ? 160 : 100 }) : placements;
  const nodeSizes = useBoardNodeSizes(visiblePlacements, nodeRefs);
  const visibleIds = new Set(visiblePlacements.map(item => item.id));
  const hiddenRelations = edges.filter(item => !visibleIds.has(item.fromPlacementId) || !visibleIds.has(item.toPlacementId));
  const width = Math.max(tree ? 900 : 1700, ...visiblePlacements.map((item) => item.x + 450));
  const height = Math.max(tree ? 700 : 1350, ...visiblePlacements.map((item) => item.y + 430));
  const matches = placements.filter((item) =>
    `${resourceTitle(data, item.resourceRef)} ${item.resourceRef.kind === 'card' ? (data.cards[item.resourceRef.id]?.body ?? '') : ''} ${item.group}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const resources = Object.values(
    pickerKind === 'card' ? data.cards : data.documents,
  ).filter((item) =>
    item.title.toLowerCase().includes(pickerQuery.toLowerCase()),
  );
  const groups = [
    ...new Set(placements.map((item) => item.group).filter(Boolean)),
  ].map((name) => {
    const members = placements
      .filter((item) => item.group === name)
      .map((item) =>
        preview[item.id] ? { ...item, ...preview[item.id] } : item,
      );
    const x = Math.min(...members.map((item) => item.x)) - 18,
      y = Math.max(8, Math.min(...members.map((item) => item.y)) - 40);
    return {
      name,
      x,
      y,
      width: Math.max(...members.map(item => item.x + (nodeSizes[item.id]?.width ?? 260))) + 20 - x,
      height: Math.max(...members.map(item => item.y + (nodeSizes[item.id]?.height ?? 215))) + 20 - y,
    };
  });

  // Overlapping group backdrops mislabel cards; keep their labels on the nodes instead.
  const safeGroups = tree ? [] : groups.filter(group => !groups.some(other => other !== group && group.x < other.x + other.width && group.x + group.width > other.x && group.y < other.y + other.height && group.y + group.height > other.y));

  useLayoutEffect(() => {
    gesture.current = undefined;
    suppressClick.current = false;
    setPreview({});
    setFreeSelection([]);
    setConnectingFrom(undefined);
    setSelectedEdge(undefined);
    setHistoryOpen(false);
    setLayoutPreview(undefined);
    setSourcePicker(undefined);
    setRemoveBranch(undefined);
    setQuestionOpen(false);
    setUndo(recentRemovals.get(boardId));
    const saved = actions.getBoardViewport(boardId);
    if (viewport.current) {
      viewport.current.scrollLeft = saved.x;
      viewport.current.scrollTop = saved.y;
    }
  }, [boardId, actions, drawingMode]);
  useEffect(() => {
    setGroupName(activePlacements[0]?.group ?? '');
  }, [selected.join(','), boardId]);
  useEffect(() => {
    const removal = recentRemovals.get(boardId);
    if (removal && removal.revision !== boardRevision) {
      recentRemovals.delete(boardId);
      setUndo(undefined);
    }
  }, [boardId, boardRevision]);
  const anchorPlacementId = (view?.anchor ?? session.anchor)?.placementId;
  useEffect(() => {
    const id = anchorPlacementId;
    const item = id ? data.placements[id] : undefined;
    if (drawingMode || !item || item.boardId !== boardId) return;
    const frame = requestAnimationFrame(() => {
      locate(item);
      actions.updateData(next => {
        const owner = next.sessions[board.researchId];
        const tab = pane && owner.layout ? findPaneTab(owner.layout, pane.tabId)?.tab : undefined;
        if (tab?.anchor?.placementId === item.id) tab.anchor = undefined;
        if (owner.anchor?.placementId === item.id) owner.anchor = undefined;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [boardId, anchorPlacementId, drawingMode, actions, pane?.tabId]);

  if (!board)
    return (
      <div className="empty-state">
        <StickyNote />
        <h2>白板已缺失</h2>
        <p>请从研究概览打开其他白板。</p>
      </div>
    );

  function report(problem: unknown) {
    setError(problem instanceof Error ? problem.message : '操作失败，请重试。');
  }
  function selectPlacements(ids: string[]) {
    setSelected(ids);
    setSelectedEdge(undefined);
    const selectedItems = placements.filter((placement) =>
      ids.includes(placement.id),
    );
    actions.setSelection({
      scope,
      viewInstanceId: pane ? `view:${pane.tabId}` : `board:${boardId}`,
      selectedItems: selectedItems.map((placement) => ({
        resourceRef: placement.resourceRef,
        placementId: placement.id,
      })),
      evidenceIds: [
        ...new Set(
          selectedItems.flatMap((placement) =>
            placement.resourceRef.kind === 'card'
              ? (data.cards[placement.resourceRef.id]?.evidenceIds ?? [])
              : [],
          ),
        ),
      ],
    });
  }
  function choose(item: BoardPlacement, multiple = false) {
    selectPlacements(
      multiple
        ? selected.includes(item.id)
          ? selected.filter((id) => id !== item.id)
          : [...selected, item.id]
        : [item.id],
    );
  }
  function inspect(
    item: BoardPlacement,
    target: 'main' | 'inspector' = 'inspector',
  ) {
    try {
      actions.openResource(item.resourceRef, {
        scope,
        target,
        anchor: { placementId: item.id },
      });
      setError('');
    } catch (problem) {
      report(problem);
    }
  }
  function clickPlacement(item: BoardPlacement, multiple: boolean) {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (mode === 'pan') return;
    if (mode === 'connect') {
      if (!connectingFrom) {
        setConnectingFrom(item.id);
        choose(item);
        return;
      }
      if (connectingFrom === item.id) {
        setError('请选择另一张卡片或论文作为连线终点。');
        return;
      }
      const id = uid('edge');
      actions.updateData((next) => {
        next.edges[id] = {
          id,
          boardId,
          fromPlacementId: connectingFrom,
          toPlacementId: item.id,
          label: '支持',
        };
      });
      setSelectedEdge(id);
      setShowRelations(true);
      setSelected([]);
      setConnectingFrom(undefined);
      setMode('select');
      setError('');
      return;
    }
    choose(item, multiple);
    if (
      !tree && !multiple &&
      item.resourceRef.kind === 'card' &&
      resourceExists(data, item.resourceRef)
    )
      inspect(item);
  }
  function moveStart(
    event: ReactPointerEvent<HTMLElement>,
    item: BoardPlacement,
  ) {
    if (
      tree || mode !== 'select' ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button,input,textarea')
    )
      return;
    suppressClick.current = false;
    const multiple = event.shiftKey || event.metaKey || event.ctrlKey;
    const items = selected.includes(item.id)
      ? activePlacements
      : multiple
        ? [...activePlacements, item]
        : [item];
    if (!multiple && !selected.includes(item.id)) choose(item);
    gesture.current = {
      kind: 'move',
      items: items.map(({ id, x, y }) => ({ id, x, y })),
      startX: event.clientX,
      startY: event.clientY,
      scale,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function gestureMove(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active) return;
    if (active.kind === 'pan') {
      if (viewport.current) {
        viewport.current.scrollLeft =
          active.x - (event.clientX - active.startX);
        viewport.current.scrollTop = active.y - (event.clientY - active.startY);
      }
    } else {
      if (
        !active.moved &&
        Math.abs(event.clientX - active.startX) +
          Math.abs(event.clientY - active.startY) >
        4
      ) {
        active.moved = true;
        selectPlacements(active.items.map(item => item.id));
      }
      if (active.moved) {
        setPreview(movedPositions(
          active.items,
          (event.clientX - active.startX) / active.scale,
          (event.clientY - active.startY) / active.scale,
        ));
      }
    }
  }
  function commitPositions(positions: Record<string, { x: number; y: number }>) {
    actions.updateData((next) => {
      for (const [id, position] of Object.entries(positions)) {
        const placement = next.placements[id];
        if (placement?.boardId === boardId) Object.assign(placement, position);
      }
    });
  }
  function gestureEnd(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (active?.kind === 'move' && active.moved) {
      commitPositions(movedPositions(
        active.items,
        (event.clientX - active.startX) / active.scale,
        (event.clientY - active.startY) / active.scale,
      ));
      suppressClick.current = true;
    }
    gesture.current = undefined;
    setPreview({});
  }
  function rememberRemoval(removal: Omit<Undo, 'revision'>) {
    const next = { ...removal, revision: boardRevision + 1 };
    recentRemovals.set(boardId, next);
    setUndo(next);
  }
  function remove(ids: string[], branch = false) {
    if (!ids.length) return;
    try {
      const before = { placements: structuredClone(placements), edges: structuredClone(edges) };
      removeBoardPlacements(boardId, ids, branch);
      rememberRemoval(before);
      setSelected([]);
      setConnectingFrom(undefined);
      setRemoveBranch(undefined);
      actions.setSelection(undefined);
      actions.notice('已移出白板，共享卡片与原文仍保留。可撤销本次移出。');
    } catch (problem) { report(problem); }
  }
  function restoreRemoval() {
    if (!undo) return;
    if (undo.revision !== boardRevision) {
      recentRemovals.delete(boardId);
      setUndo(undefined);
      setError('白板已有后续修改，请从版本历史查看或恢复为副本。');
      return;
    }
    actions.updateData((next) => {
      Object.values(next.placements).filter(item => item.boardId === boardId).forEach(item => delete next.placements[item.id]);
      Object.values(next.edges).filter(item => item.boardId === boardId).forEach(item => delete next.edges[item.id]);
      undo.placements.forEach((item) => {
        next.placements[item.id] = item;
      });
      undo.edges.forEach((item) => {
        if (
          next.placements[item.fromPlacementId] &&
          next.placements[item.toPlacementId]
        )
          next.edges[item.id] = item;
      });
    });
    recentRemovals.delete(boardId);
    setUndo(undefined);
    actions.notice('已恢复上次移出的摆放实例与连线。');
  }
  function zoom(nextScale: number) {
    const element = viewport.current;
    const next = Math.max(0.4, Math.min(1.6, Math.round(nextScale * 10) / 10));
    const x = element
      ? Math.max(
          0,
          ((element.scrollLeft + element.clientWidth / 2) * next) / scale -
            element.clientWidth / 2,
        )
      : 0;
    const y = element
      ? Math.max(
          0,
          ((element.scrollTop + element.clientHeight / 2) * next) / scale -
            element.clientHeight / 2,
        )
      : 0;
    actions.setBoardViewport(boardId, { x, y, scale: next });
    requestAnimationFrame(() => {
      if (element) {
        element.scrollLeft = x;
        element.scrollTop = y;
      }
    });
  }
  function locate(item: BoardPlacement) {
    const ancestors = new Set<string>();
    let parent = item.parentPlacementId;
    while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = placements.find(p => p.id === parent)?.parentPlacementId; }
    const expanded = collapsed.filter(id => !ancestors.has(id));
    if (tree) setCollapsedJSON(JSON.stringify(expanded));
    const position = tree ? layoutBoardTree(placements, { collapsedIds: expanded, nodeHeight: summary ? 160 : 100 }).find(p => p.id === item.id) ?? item : item;
    choose(item);
    requestAnimationFrame(() => {
      const element = viewport.current;
      if (element) {
        element.scrollLeft = Math.max(0, position.x * scale - element.clientWidth / 3);
        element.scrollTop = Math.max(0, position.y * scale - element.clientHeight / 3);
      }
      nodeRefs.current[item.id]?.focus({ preventScroll: true });
    });
  }
  function toggleBranch(id: string) {
    const closing = !collapsed.includes(id);
    setCollapsedJSON(JSON.stringify(closing ? [...collapsed, id] : collapsed.filter(item => item !== id)));
    if (closing && selected.some(item => boardDescendants(placements, id).includes(item))) selectPlacements([id]);
  }
  function structureAction(action: () => void) {
    try { action(); setError(''); } catch (problem) { report(problem); }
  }
  function openSource(evidenceId: string) {
    const evidence = data.evidence[evidenceId];
    if (!evidence || !data.documents[evidence.documentId]) { setError('这条原文来源已缺失，请在卡片中修复引用。'); return; }
    structureAction(() => {
      actions.openResource({ kind: 'document', id: evidence.documentId }, { scope, target: 'inspector', anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex } });
      setSourcePicker(undefined);
    });
  }
  function source(item: BoardPlacement) {
    const evidenceIds = item.resourceRef.kind === 'card' ? data.cards[item.resourceRef.id]?.evidenceIds ?? [] : [];
    if (evidenceIds.length > 1) setSourcePicker(item);
    else if (evidenceIds.length === 1) openSource(evidenceIds[0]);
    else setError('这张卡片未关联原文，可在右侧编辑并补充依据。');
  }

  return (
    <div className={`board-view ${tree ? `is-tree ${summary ? 'show-summary' : 'show-titles'}` : ''}`}>
      <div className="toolbar board-toolbar">
        <button className="button" aria-pressed={drawingMode} onClick={() => {
          const nextMode = drawingMode ? 'organize' : 'draw';
          setCanvasMode(nextMode);
          actions.updateData(next => { (next.sessions[board.researchId].boardModes ??= {})[boardId] = nextMode; });
          setSelected([]); setSelectedEdge(undefined); setConnectingFrom(undefined); setMode('select'); setQuery('');
        }}><Pencil size={15} />{drawingMode ? '卡片布局' : '绘图'}</button>
        {!drawingMode && <div className="board-mode-buttons" aria-label="白板工具">
          <button
            className={`icon-button ${mode === 'select' ? 'is-active' : ''}`}
            aria-label={tree ? "选择节点" : "选择与移动"}
            title={tree ? "层级模式通过大纲调整顺序与归属" : "选择与移动"}
            onClick={() => {
              setMode('select');
              setConnectingFrom(undefined);
            }}
          >
            <MousePointer2 size={17} />
          </button>
          <button
            className={`icon-button ${mode === 'pan' ? 'is-active' : ''}`}
            aria-label="平移白板"
            title="平移白板"
            onClick={() => setMode('pan')}
          >
            <Hand size={17} />
          </button>
          <button
            className={`icon-button ${mode === 'connect' ? 'is-active' : ''}`}
            aria-label="连接卡片"
            title="依次点击两个摆放实例建立连线"
            onClick={() => {
              setMode('connect');
              setConnectingFrom(undefined);
            }}
          >
            <Link2 size={17} />
          </button>
        </div>}
        <button
          className="button"
          onClick={() => {
            setPickerOpen(!pickerOpen);
            setError('');
          }}
          aria-expanded={pickerOpen}
        >
          <Plus size={15} />
          添加资料
        </button>
        <button className="button" onClick={() => {
          const view = viewport.current;
          setQuestionPosition(drawingMode ? drawingPosition.current : {
            x: Math.max(30, (view?.scrollLeft ?? 0) / scale + Math.max(40, ((view?.clientWidth ?? 500) / scale - 260) / 2)),
            y: Math.max(55, (view?.scrollTop ?? 0) / scale + 100),
          });
          setQuestionOpen(true);
        }}><Pencil size={14} />写问题</button>
        {!drawingMode && <label className="board-search">
          <Search size={14} />
          <input
            aria-label="查找白板资料"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="查找白板"
          />
        </label>}
        {!drawingMode && <button
          className="icon-button"
          aria-label="撤销移出"
          title="撤销上次移出"
          disabled={!undo || undo.revision !== boardRevision}
          onClick={restoreRemoval}
        >
          <Undo2 size={16} />
        </button>}
        <span className="board-toolbar-spacer" />
        <button className="button" title={drawingMode ? '整理卡片与论文的关系；自由绘图不会自动发送。' : undefined} onClick={() => {
          const conversation = getActiveConversation(data, board.researchId);
          const conversationId = conversation?.id ?? actions.createConversation(board.researchId);
          actions.updateData(next => {
            next.conversations[conversationId].boardSkill = { boardId, scope: 'board', allowNewCards: true };
            next.sessions[board.researchId].panel.aiView = 'chat';
          });
          actions.setPanel('ai');
        }}><Sparkles size={14} />{drawingMode ? '整理资料关系' : '让 Agent 整理'}</button>
        <button className="button" aria-label="白板版本历史" title="查看历史并恢复布局，保留共享卡片正文" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History size={16} />历史与恢复</button>
        {!drawingMode && <><button
          className="icon-button"
          aria-label="缩小白板"
          disabled={scale <= 0.4}
          onClick={() => zoom(scale - 0.1)}
        >
          <ZoomOut size={16} />
        </button>
        <button
          className="board-scale"
          aria-label="重置白板缩放"
          onClick={() => zoom(1)}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          className="icon-button"
          aria-label="放大白板"
          disabled={scale >= 1.6}
          onClick={() => zoom(scale + 0.1)}
        >
          <ZoomIn size={16} />
        </button></>}
      </div>
      {!drawingMode && <div className="board-structure-toolbar" aria-label="白板结构与展示">
        <button className="button" aria-label={tree ? '切换为自由布局' : '预览层级整理'} onClick={() => tree ? structureAction(() => setBoardLayout(boardId, 'free')) : setLayoutPreview(boardRevision)}><GitBranch size={14} />{tree ? '层级整理 · 切换自由布局' : '层级整理'}</button>
        {tree && <>
          <button className="button" aria-expanded={outlineOpen} onClick={() => setOutlineOpen(!outlineOpen)}><ListTree size={14} />大纲与节点</button>
          <button className="button" aria-pressed={summary} onClick={() => setSummary(!summary)}>{summary ? '显示标题' : '显示摘要'}</button>
          <button className="button" aria-pressed={showRelations} onClick={() => { setShowRelations(!showRelations); setSelectedEdge(undefined); }}><Link2 size={14} />{showRelations ? '隐藏' : '显示'}关联 · {edges.length}</button>
          {hiddenRelations.length > 0 && <button className="button" title="展开所有分支，查看真实关联端点" onClick={() => { setCollapsedJSON('[]'); setShowRelations(true); }}>{hiddenRelations.length} 条关联因折叠隐藏</button>}
        </>}
      </div>}
      {layoutPreview !== undefined && <BoardLayoutPreview placements={placements} title={item => resourceTitle(data, item.resourceRef)} stale={layoutPreview !== boardRevision}
        onCancel={() => setLayoutPreview(undefined)} onConfirm={() => structureAction(() => {
          setBoardLayout(boardId, 'tree');
          setLayoutPreview(undefined);
          setOutlineOpen(true);
          actions.setBoardViewport(boardId, { x: 0, y: 0, scale: 1 });
          if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
        })} />}
      {sourcePicker && <div className="board-picker board-source-picker" role="dialog" aria-label="选择卡片原文"><div className="section-heading"><strong>选择原文出处</strong><button className="icon-button" aria-label="关闭原文选择" onClick={() => setSourcePicker(undefined)}><X size={16} /></button></div><div className="board-picker-list">{(sourcePicker.resourceRef.kind === 'card' ? data.cards[sourcePicker.resourceRef.id]?.evidenceIds ?? [] : []).map(id => { const evidence = data.evidence[id]; return <button key={id} className="board-picker-item" onClick={() => openSource(id)}>{evidence ? `${data.documents[evidence.documentId]?.title ?? '文献已缺失'} · PDF 第 ${evidence.pageIndex + 1} 页` : '来源已缺失'}</button>; })}</div></div>}
      {removeBranch && <div className="board-message" role="alert"><span>将移出该节点及 {boardDescendants(placements, removeBranch).length} 个后代；共享卡片与原文保留。</span><button className="button" onClick={() => remove([removeBranch], true)}>确认移出整枝</button><button className="button" onClick={() => setRemoveBranch(undefined)}>取消</button></div>}
      {historyOpen && <BoardHistoryPanel key={boardId} boardId={boardId} onClose={() => setHistoryOpen(false)} />}
      {(error || mode !== 'select') && (
        <div
          className={`board-message ${error ? 'has-error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ||
            (mode === 'connect'
              ? connectingFrom
                ? '点击连线终点；按 Esc 取消。'
                : '依次点击两个摆放实例建立连线。'
              : '拖动空白处平移，滚动也可移动白板。')}
          <button
            className="icon-button"
            aria-label="关闭白板提示"
            onClick={() => {
              setError('');
              setMode('select');
              setConnectingFrom(undefined);
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {query && (
        <div className="board-search-results" aria-label="白板查找结果">
          {matches.length ? (
            matches.map((item) => (
              <button
                key={item.id}
                className="button"
                onClick={() => locate(item)}
              >
                {resourceTitle(data, item.resourceRef)}
              </button>
            ))
          ) : (
            <span className="muted">没有找到匹配资料</span>
          )}
        </div>
      )}
      {pickerOpen && (
        <div className="board-picker" aria-label="添加白板资料">
          <div className="section-heading">
            <strong>添加已有资料</strong>
            <button
              className="icon-button"
              aria-label="关闭添加资料"
              onClick={() => setPickerOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <div className="board-picker-tabs">
            <button
              className={`button ${pickerKind === 'card' ? 'primary' : ''}`}
              onClick={() => setPickerKind('card')}
            >
              <StickyNote size={14} />
              观点卡片
            </button>
            <button
              className={`button ${pickerKind === 'document' ? 'primary' : ''}`}
              onClick={() => setPickerKind('document')}
            >
              <FileText size={14} />
              PDF 论文
            </button>
          </div>
          <input
            className="field"
            aria-label="搜索待添加资料"
            value={pickerQuery}
            placeholder="搜索全部资料"
            onChange={(event) => setPickerQuery(event.target.value)}
          />
          <p className="muted">
            资料及其来源会同时加入当前研究。同一资料可摆放多次。
          </p>
          <div className="board-picker-list">
            {resources.map((resource) => (
              <button
                key={resource.id}
                className="board-picker-item"
                aria-label={`添加到白板：${resource.title}`}
                onClick={() => {
                  try {
                    const added = actions.addPlacement(boardId, {
                      kind: pickerKind,
                      id: resource.id,
                    });
                    setPickerOpen(false);
                    setSelected([added.id]);
                    setError('');
                    requestAnimationFrame(() => {
                      const element = viewport.current;
                      if (element) {
                        element.scrollLeft = Math.max(0, added.x * scale - 80);
                        element.scrollTop = Math.max(0, added.y * scale - 80);
                      }
                    });
                  } catch (problem) {
                    report(problem);
                  }
                }}
              >
                <span>
                  {pickerKind === 'card' ? (
                    <StickyNote size={15} />
                  ) : (
                    <FileText size={15} />
                  )}
                  {resource.title}
                </span>
                <Plus size={14} />
              </button>
            ))}
            {!resources.length && (
              <p className="muted">
                没有匹配资料。请先导入论文或创建证据卡片。
              </p>
            )}
          </div>
        </div>
      )}
      {drawingMode ? <Suspense fallback={<div className="empty-state" role="status">正在加载绘图工具…</div>}><BoardDrawing key={boardId} boardId={boardId} onViewport={position => { drawingPosition.current = position; }} /></Suspense> : <div className="board-workarea">
      {tree && outlineOpen && <BoardOutline placements={placements} selected={selected} collapsed={collapsed} title={item => resourceTitle(data, item.resourceRef)} onLocate={locate} onToggle={toggleBranch}
        onReorder={(id, direction) => structureAction(() => reorderBoardPlacement(boardId, id, direction))}
        onMove={(id, parent) => structureAction(() => { moveBoardBranch(boardId, id, parent); if (parent) setCollapsedJSON(JSON.stringify(collapsed.filter(item => item !== parent))); })}
        onAdd={(title, parent) => { try { const id = addBoardCard(boardId, title, parent); setSelected([id]); if (parent) setCollapsedJSON(JSON.stringify(collapsed.filter(item => item !== parent))); setError(''); return true; } catch (problem) { report(problem); return false; } }} onClose={() => setOutlineOpen(false)} />}
      <div
        className={`board-viewport mode-${mode}`}
        ref={viewport}
        onScroll={(event) => {
          const x = event.currentTarget.scrollLeft,
            y = event.currentTarget.scrollTop,
            current = actions.getBoardViewport(boardId);
          if (current?.x === x && current?.y === y) return;
          actions.setBoardViewport(boardId, { x, y, scale });
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target as HTMLElement).closest('.board-node,.board-edge')
          )
            return;
          if (mode === 'pan') {
            gesture.current = {
              kind: 'pan',
              startX: event.clientX,
              startY: event.clientY,
              x: event.currentTarget.scrollLeft,
              y: event.currentTarget.scrollTop,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          } else if (mode === 'select') {
            setSelected([]);
            setSelectedEdge(undefined);
            actions.setSelection(undefined);
          }
        }}
        onPointerMove={gestureMove}
        onPointerUp={gestureEnd}
        onPointerCancel={() => {
          gesture.current = undefined;
          setPreview({});
        }}
      >
        <div
          className="board-scaled-area"
          style={{ width: width * scale, height: height * scale }}
        >
          <div
            className="board-canvas"
            style={{ width, height, transform: `scale(${scale})` }}
          >
            {safeGroups.map((group, index) => (
              <div
                className={`board-group group-color-${index % 4}`}
                key={group.name}
                style={{
                  left: group.x,
                  top: group.y,
                  width: group.width,
                  height: group.height,
                }}
              >
                <button type="button" aria-label={`选择分区：${group.name}`} onPointerDown={event => event.stopPropagation()} onClick={event => {
                  event.stopPropagation();
                  selectPlacements(placements.filter(item => item.group === group.name).map(item => item.id));
                }}>{group.name}</button>
              </div>
            ))}
            <BoardConnections
              structural={tree}
              showRelations={!tree || showRelations}
              selectedPlacements={selected}
              placements={visiblePlacements.map(item => ({ ...item, ...preview[item.id] }))}
              edges={edges}
              selectedEdge={selectedEdge}
              onSelectEdge={(id) => {
                setSelectedEdge(id);
                setSelected([]);
                actions.setSelection(undefined);
              }}
              width={width}
              height={height}
              sizes={nodeSizes}
            />
            {visiblePlacements.map((item) => {
              const ref = item.resourceRef,
                card = ref.kind === 'card' ? data.cards[ref.id] : undefined,
                document =
                  ref.kind === 'document' ? data.documents[ref.id] : undefined;
              const position = preview[item.id] ?? item;
              const exists = resourceExists(data, ref),
                isSelected = selected.includes(item.id);
              const hasChildren = placements.some(child => child.parentPlacementId === item.id);
              const NodeIcon = document ? FileText : !item.parentPlacementId ? Target : hasChildren ? GitBranch : StickyNote;
              const nodeKind = document ? '原始文献' : !item.parentPlacementId ? '根主题卡片' : hasChildren ? '分支主题卡片' : '观点卡片';
              return (
                <article
                  key={item.id}
                  ref={(element) => {
                    nodeRefs.current[item.id] = element;
                  }}
                  className={`board-node ${tree && !item.parentPlacementId ? 'is-tree-root' : ''} ${tree && placements.some(child => child.parentPlacementId === item.id) ? 'is-tree-branch' : ''} ${ref.kind === 'document' ? 'is-document' : ''} ${isSelected ? 'is-selected' : ''} ${connectingFrom === item.id ? 'is-connecting' : ''} ${query && !matches.some((match) => match.id === item.id) ? 'is-dimmed' : ''}`}
                  data-placement-id={item.id}
                  data-resource-id={ref.id}
                  style={{ left: position.x, top: position.y }}
                  title={resourceTitle(data, ref)}
                  tabIndex={0}
                  aria-label={`白板${ref.kind === 'card' ? '卡片' : '论文'}：${resourceTitle(data, ref)}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    moveStart(event, item);
                  }}
                  onClick={(event) =>
                    clickPlacement(
                      item,
                      event.shiftKey || event.metaKey || event.ctrlKey,
                    )
                  }
                  onDoubleClick={() => {
                    if (mode === 'select' && exists && ref.kind === 'document')
                      inspect(item, 'main');
                  }}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest('button,input,textarea,[contenteditable="true"]'))
                      return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (mode === 'connect') clickPlacement(item, false);
                      else
                        inspect(
                          item,
                          ref.kind === 'document' ? 'main' : 'inspector',
                        );
                    }
                    if (event.key === 'Delete' || event.key === 'Backspace') {
                      event.preventDefault();
                      remove([item.id]);
                    }
                    if (event.key === 'Escape') {
                      setConnectingFrom(undefined);
                      setMode('select');
                    }
                    if (
                      [
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown',
                      ].includes(event.key) &&
                      mode === 'select' && !tree &&
                      !event.altKey && !event.ctrlKey && !event.metaKey
                    ) {
                      event.preventDefault();
                      const items = isSelected ? activePlacements : [item];
                      if (!isSelected) choose(item);
                      const step = event.shiftKey ? 10 : 1;
                      commitPositions(movedPositions(items,
                        event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
                        event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0,
                      ));
                    }
                  }}
                >
                  {tree ? <>
                    <div className="board-tree-title">
                      <span className="board-node-kind" title={nodeKind}><NodeIcon size={15} /></span>
                      <h3>{resourceTitle(data, ref)}</h3>
                      {hasChildren && <button className="board-fold-button" aria-label={`${collapsed.includes(item.id) ? '展开' : '收起'}分支：${resourceTitle(data, ref)}`} aria-expanded={!collapsed.includes(item.id)} onClick={event => { event.stopPropagation(); toggleBranch(item.id); }}>{collapsed.includes(item.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{collapsed.includes(item.id) && boardDescendants(placements, item.id).length}</button>}
                    </div>
                    {summary && <p className="board-card-body">{card?.body || document?.authors || '选择“编辑”补充你的理解。'}</p>}
                    <div className="board-tree-footer"><span className={card?.needsReview ? 'needs-review' : ''}>{card?.needsReview ? '待核查' : document ? '原始文献' : card?.evidenceIds.length ? `${card.evidenceIds.length} 条来源` : '未关联原文'}</span><div className="board-node-actions">
                      <button className="board-source-button" aria-label={`编辑内容：${resourceTitle(data, ref)}`} onClick={event => { event.stopPropagation(); choose(item); inspect(item); }}>{document ? '详情' : '编辑'}</button>
                      <button className="board-source-button" aria-label={`查看卡片原文：${resourceTitle(data, ref)}`} disabled={!document && !card?.evidenceIds.length} title={!document && !card?.evidenceIds.length ? '未关联原文，可在卡片中补充依据' : '在右侧查看原文'} onClick={event => { event.stopPropagation(); document ? inspect(item) : source(item); }}>原文{(card?.evidenceIds.length ?? 0) > 1 ? ` · ${card!.evidenceIds.length}` : ''}</button>
                    </div></div>
                  </> : <>
                  <div className="board-node-header" title="拖动移动；Shift / Ctrl / ⌘ 点击多选后可整体拖动">
                    <span>
                      {ref.kind === 'document' ? (
                        <FileText size={14} />
                      ) : (
                        <StickyNote size={14} />
                      )}
                      {ref.kind === 'document' ? hasFullText(document) ? 'PDF 论文' : '文献条目' : '观点卡片'}
                    </span>
                    <span className="board-drag-hint"><Grip size={14} />拖动</span>
                  </div>
                  {item.group && !safeGroups.some(group => group.name === item.group) && <span className="board-node-group">{item.group}</span>}
                  <h3 title={resourceTitle(data, ref)}>{resourceTitle(data, ref)}</h3>
                  {card && (
                    <p className="board-card-body">
                      {card.body || '还没有正文，点击在右侧编辑。'}
                    </p>
                  )}
                  {document && (
                    <div className="board-document-preview">
                      <FileText size={35} strokeWidth={1.2} />
                      <span title={document.authors}>{document.authors}</span>
                      <small>
                        {document.year || '年份未记录'} · {hasFullText(document) ? `${document.pageCount} 页` : '全文未导入'}
                      </small>
                      <em>{hasFullText(document) ? '双击进入阅读器' : '双击查看资料'}</em>
                    </div>
                  )}
                  {!exists && (
                    <p className="board-missing">
                      资料已缺失。可移出此实例，再从资料库添加。
                    </p>
                  )}
                  <div className="board-node-footer">
                    <span
                      className={`board-node-status ${card?.needsReview ? 'needs-review' : ''}`}
                    >
                      {card
                        ? `${card.evidenceIds.length} 条来源${card.needsReview ? ' · 待核查' : ''}`
                        : hasFullText(document) ? '原始文献' : '全文未导入'}
                    </span>
                    {card && (
                      <div className="board-node-actions">
                        <button
                          className="board-source-button"
                          aria-label={`编辑内容：${card.title}`}
                          title="在右侧编辑标题与正文，修改会同步到所有使用处"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            choose(item);
                            inspect(item);
                          }}
                        >
                          <Pencil size={12} />
                          编辑内容
                        </button>
                        <button
                          className="board-source-button"
                          aria-label={`查看卡片原文：${card.title}`}
                          disabled={!card.evidenceIds.length}
                          title={card.evidenceIds.length ? '在右侧查看原文' : '未关联原文，可在卡片中补充依据'}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.stopPropagation();
                            source(item);
                          }}
                        >
                          <ArrowUpRight size={13} />
                          原文
                        </button>
                      </div>
                    )}
                    {document && (
                      <button
                        className="board-source-button"
                        aria-label={`右侧预览论文：${document.title}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          inspect(item);
                        }}
                      >
                        <ArrowUpRight size={13} />
                        预览
                      </button>
                    )}
                  </div>
                  </>}
                </article>
              );
            })}
            {mode === 'select' && activePlacements.length > 0 && <div className="board-local-research" style={{
              left: Math.min(...activePlacements.map(item => item.x)),
              top: Math.max(8, Math.min(...activePlacements.map(item => item.y)) - 45),
            }}><BoardResearchActions boardId={boardId} placementIds={activePlacements.map(item => item.id)} /></div>}
            {!placements.length && (
              <div className="board-empty">
                <StickyNote size={30} strokeWidth={1.2} />
                <h2>让证据形成论证</h2>
                <p>添加卡片与论文，比较观点、标记条件，建立它们之间的关系。</p>
                <button
                  className="button primary"
                  onClick={() => setPickerOpen(true)}
                >
                  <Plus size={15} />
                  添加第一份资料
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      </div>}
      {!drawingMode && (activePlacements.length > 0 || edge) && (
        <div className="board-selection-bar" aria-label="白板选中项操作">
          {activePlacements.length > 0 && (
            <>
              <span className="muted">已选 {activePlacements.length} 项</span>
              {!tree && <>
              <input
                aria-label="白板分组名称"
                list={`groups-${domId}`}
                placeholder="分组名称"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
              />
              <datalist id={`groups-${domId}`}>
                {groups.map((group) => (
                  <option key={group.name}>{group.name}</option>
                ))}
              </datalist>
              <button
                className="button"
                onClick={() =>
                  actions.updateData((next) => {
                    activePlacements.forEach((item) => {
                      next.placements[item.id].group = groupName.trim();
                    });
                  })
                }
              >
                应用分组
              </button>
              </>}
              {tree && activePlacements.length === 1 && <><button className="button" onClick={() => selectPlacements([activePlacements[0].id, ...boardDescendants(placements, activePlacements[0].id)])}>选中整枝 · {boardDescendants(placements, activePlacements[0].id).length + 1}</button><button className="button" onClick={() => setRemoveBranch(activePlacements[0].id)}>移出整枝…</button><button className="button" onClick={() => setOutlineOpen(true)}>调整顺序与归属</button></>}
              <button className="button" onClick={() => remove(selected)}>
                <Trash2 size={14} />
                移出白板
              </button>
            </>
          )}
          {edge && (
            <>
              <span className="muted">关系说明</span>
              <input
                aria-label="连线说明"
                value={edge.label}
                onChange={(event) =>
                  actions.updateData((next) => {
                    next.edges[edge.id].label = event.target.value;
                  })
                }
              />
              <button
                className="button"
                onClick={() => {
                  rememberRemoval({ placements: structuredClone(placements), edges: structuredClone(edges) });
                  actions.updateData((next) => {
                    delete next.edges[edge.id];
                  });
                  setSelectedEdge(undefined);
                }}
              >
                <Trash2 size={14} />
                移除连线
              </button>
            </>
          )}
        </div>
      )}
      <div className="board-bottom-hint">
        <span>
          {placements.length} 项资料{!drawingMode && ` · ${edges.length} 个关系`}
        </span>
        <span>{drawingMode ? '箭头可连接资料与图形 · 框选内容问 Agent' : tree ? '层级模式不拖动改归属 · 在大纲调整顺序与分支 · 点编辑看全文' : '拖动移动 · Shift / Ctrl / ⌘ 多选 · 方向键 1px · Shift + 方向键 10px'}</span>
      </div>
      <BoardQuestionDialog boardId={boardId} open={questionOpen} onClose={() => setQuestionOpen(false)} position={questionPosition} onCreated={id => {
        setSelected([id]);
        requestAnimationFrame(() => {
          const item = actions.getState().data.placements[id];
          if (item && viewport.current) {
            viewport.current.scrollLeft = Math.max(0, item.x * scale - 80);
            viewport.current.scrollTop = Math.max(0, item.y * scale - 80);
          }
        });
      }} />
    </div>
  );
}
