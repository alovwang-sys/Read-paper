import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  ArrowUpRight,
  FileText,
  Grip,
  Hand,
  Link2,
  MousePointer2,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { BoardEdge, BoardPlacement } from '../../domain/types';
import {
  resourceExists,
  resourceTitle,
  uid,
  useWorkspace,
} from '../../services/workspace';
import './board.css';

type Undo = { placements: BoardPlacement[]; edges: BoardEdge[] };
const recentRemovals = new Map<string, Undo>();

export function BoardView({ boardId }: { boardId: string }) {
  const { data, session, actions } = useWorkspace();
  const board = data.boards[boardId];
  const [mode, setMode] = useState<'select' | 'connect' | 'pan'>('select');
  const [selected, setSelected] = useState<string[]>([]);
  const [connectingFrom, setConnectingFrom] = useState<string>();
  const [selectedEdge, setSelectedEdge] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState<'card' | 'document'>('card');
  const [query, setQuery] = useState('');
  const [pickerQuery, setPickerQuery] = useState('');
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<Undo | undefined>(() =>
    recentRemovals.get(boardId),
  );
  const [preview, setPreview] = useState<{
    id: string;
    x: number;
    y: number;
  }>();
  const viewport = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Record<string, HTMLElement | null>>({});
  const gesture = useRef<
    | {
        kind: 'move';
        id: string;
        startX: number;
        startY: number;
        x: number;
        y: number;
        moved: boolean;
      }
    | { kind: 'pan'; startX: number; startY: number; x: number; y: number }
    | undefined
  >(undefined);
  const suppressClick = useRef(false);
  const scale = session.viewports[boardId]?.scale ?? 1;
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
  const width = Math.max(1700, ...placements.map((item) => item.x + 450));
  const height = Math.max(1350, ...placements.map((item) => item.y + 430));
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
        preview?.id === item.id ? { ...item, ...preview } : item,
      );
    const x = Math.min(...members.map((item) => item.x)) - 18,
      y = Math.max(8, Math.min(...members.map((item) => item.y)) - 40);
    return {
      name,
      x,
      y,
      width: Math.max(...members.map((item) => item.x)) + 280 - x,
      height: Math.max(...members.map((item) => item.y)) + 235 - y,
    };
  });

  useEffect(() => {
    setSelected([]);
    setConnectingFrom(undefined);
    setSelectedEdge(undefined);
    setUndo(recentRemovals.get(boardId));
    const saved = actions.getSession().viewports[boardId];
    const frame = requestAnimationFrame(() => {
      if (viewport.current) {
        viewport.current.scrollLeft = saved?.x ?? 0;
        viewport.current.scrollTop = saved?.y ?? 0;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [boardId, actions]);
  useEffect(() => {
    setGroupName(activePlacements[0]?.group ?? '');
  }, [selected.join(','), boardId]);

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
  function choose(item: BoardPlacement, multiple = false) {
    const ids = multiple
      ? selected.includes(item.id)
        ? selected.filter((id) => id !== item.id)
        : [...selected, item.id]
      : [item.id];
    setSelected(ids);
    setSelectedEdge(undefined);
    const selectedItems = placements.filter((placement) =>
      ids.includes(placement.id),
    );
    actions.setSelection({
      scope,
      viewInstanceId: `board:${boardId}`,
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
      setSelected([]);
      setConnectingFrom(undefined);
      setMode('select');
      setError('');
      return;
    }
    choose(item, multiple);
    if (
      !multiple &&
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
      mode !== 'select' ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button,input,textarea')
    )
      return;
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) choose(item);
    gesture.current = {
      kind: 'move',
      id: item.id,
      startX: event.clientX,
      startY: event.clientY,
      x: item.x,
      y: item.y,
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
        Math.abs(event.clientX - active.startX) +
          Math.abs(event.clientY - active.startY) >
        4
      )
        active.moved = true;
      if (active.moved)
        setPreview({
          id: active.id,
          x: Math.max(20, active.x + (event.clientX - active.startX) / scale),
          y: Math.max(55, active.y + (event.clientY - active.startY) / scale),
        });
    }
  }
  function gestureEnd(event: ReactPointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (active?.kind === 'move' && active.moved) {
      const x = Math.max(
          20,
          active.x + (event.clientX - active.startX) / scale,
        ),
        y = Math.max(55, active.y + (event.clientY - active.startY) / scale);
      actions.updateData((next) => {
        if (next.placements[active.id]) {
          next.placements[active.id].x = Math.round(x);
          next.placements[active.id].y = Math.round(y);
        }
      });
      suppressClick.current = true;
    }
    gesture.current = undefined;
    setPreview(undefined);
  }
  function rememberRemoval(removal: Undo) {
    recentRemovals.set(boardId, removal);
    setUndo(removal);
  }
  function remove(ids: string[]) {
    const removed = {
      placements: placements.filter((item) => ids.includes(item.id)),
      edges: edges.filter(
        (item) =>
          ids.includes(item.fromPlacementId) ||
          ids.includes(item.toPlacementId),
      ),
    };
    if (!removed.placements.length) return;
    rememberRemoval(removed);
    actions.updateData((next) => {
      removed.placements.forEach((item) => delete next.placements[item.id]);
      removed.edges.forEach((item) => delete next.edges[item.id]);
    });
    setSelected([]);
    setConnectingFrom(undefined);
    actions.setSelection(undefined);
    actions.notice('已移出白板，资料仍保留在卡片库或论文库。可撤销本次移出。');
  }
  function restoreRemoval() {
    if (!undo) return;
    actions.updateData((next) => {
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
    actions.updateData((current) => {
      current.sessions[board.researchId].viewports[boardId] = {
        x,
        y,
        scale: next,
      };
    });
    requestAnimationFrame(() => {
      if (element) {
        element.scrollLeft = x;
        element.scrollTop = y;
      }
    });
  }
  function locate(item: BoardPlacement) {
    const element = viewport.current;
    if (element) {
      element.scrollLeft = Math.max(
        0,
        item.x * scale - element.clientWidth / 3,
      );
      element.scrollTop = Math.max(
        0,
        item.y * scale - element.clientHeight / 3,
      );
    }
    choose(item);
    nodeRefs.current[item.id]?.focus({ preventScroll: true });
  }
  function source(item: BoardPlacement) {
    const evidenceId =
      item.resourceRef.kind === 'card'
        ? data.cards[item.resourceRef.id]?.evidenceIds[0]
        : undefined;
    const evidence = evidenceId ? data.evidence[evidenceId] : undefined;
    if (evidence && data.documents[evidence.documentId]) {
      try {
        actions.openResource(
          { kind: 'document', id: evidence.documentId },
          {
            scope,
            target: 'inspector',
            anchor: { evidenceId: evidence.id, pageIndex: evidence.pageIndex },
          },
        );
      } catch (problem) {
        report(problem);
      }
    } else setError('这张卡片的原文来源已缺失，请在卡片中修复引用。');
  }

  return (
    <div className="board-view">
      <div className="toolbar board-toolbar">
        <div className="board-mode-buttons" aria-label="白板工具">
          <button
            className={`icon-button ${mode === 'select' ? 'is-active' : ''}`}
            aria-label="选择与移动"
            title="选择与移动"
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
        </div>
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
        <label className="board-search">
          <Search size={14} />
          <input
            aria-label="查找白板资料"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="查找白板"
          />
        </label>
        <button
          className="icon-button"
          aria-label="撤销移出"
          title="撤销上次移出"
          disabled={!undo}
          onClick={restoreRemoval}
        >
          <Undo2 size={16} />
        </button>
        <span className="board-toolbar-spacer" />
        <button
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
        </button>
      </div>
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
      <div
        className={`board-viewport mode-${mode}`}
        ref={viewport}
        onScroll={(event) => {
          const x = event.currentTarget.scrollLeft,
            y = event.currentTarget.scrollTop,
            current = session.viewports[boardId];
          if (current?.x === x && current?.y === y) return;
          actions.updateData((next) => {
            next.sessions[board.researchId].viewports[boardId] = {
              x,
              y,
              scale,
            };
          });
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
          setPreview(undefined);
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
            {groups.map((group, index) => (
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
                <span>{group.name}</span>
              </div>
            ))}
            <svg
              className="board-edges"
              width={width}
              height={height}
              aria-label="论证关系"
            >
              <defs>
                <marker
                  id={`arrow-${boardId}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#7d9180" />
                </marker>
              </defs>
              {edges.map((item) => {
                const from = data.placements[item.fromPlacementId],
                  to = data.placements[item.toPlacementId];
                if (
                  !from ||
                  !to ||
                  from.boardId !== boardId ||
                  to.boardId !== boardId
                )
                  return null;
                const origin = preview?.id === from.id ? preview : from,
                  destination = preview?.id === to.id ? preview : to;
                const x1 = origin.x + 130,
                  y1 = origin.y + 110,
                  x2 = destination.x + 130,
                  y2 = destination.y + 110;
                const middleX = (x1 + x2) / 2,
                  middleY = (y1 + y2) / 2;
                return (
                  <g
                    key={item.id}
                    className={`board-edge ${selectedEdge === item.id ? 'is-selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`编辑关系：${item.label || '未命名'}`}
                    onClick={() => {
                      setSelectedEdge(item.id);
                      setSelected([]);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        setSelectedEdge(item.id);
                        setSelected([]);
                      }
                    }}
                  >
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      markerEnd={`url(#arrow-${boardId})`}
                    />
                    <line
                      className="board-edge-hit"
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                    />
                    <rect
                      x={middleX - 48}
                      y={middleY - 13}
                      width="96"
                      height="26"
                      rx="6"
                    />
                    <text x={middleX} y={middleY + 4} textAnchor="middle">
                      {item.label.slice(0, 12) || '添加说明'}
                    </text>
                  </g>
                );
              })}
            </svg>
            {placements.map((item) => {
              const ref = item.resourceRef,
                card = ref.kind === 'card' ? data.cards[ref.id] : undefined,
                document =
                  ref.kind === 'document' ? data.documents[ref.id] : undefined;
              const position = preview?.id === item.id ? preview : item;
              const exists = resourceExists(data, ref),
                isSelected = selected.includes(item.id);
              return (
                <article
                  key={item.id}
                  ref={(element) => {
                    nodeRefs.current[item.id] = element;
                  }}
                  className={`board-node ${ref.kind === 'document' ? 'is-document' : ''} ${isSelected ? 'is-selected' : ''} ${connectingFrom === item.id ? 'is-connecting' : ''} ${query && !matches.some((match) => match.id === item.id) ? 'is-dimmed' : ''}`}
                  data-placement-id={item.id}
                  data-resource-id={ref.id}
                  style={{ left: position.x, top: position.y }}
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
                    if ((event.target as HTMLElement).closest('button,input'))
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
                      mode === 'select'
                    ) {
                      event.preventDefault();
                      actions.updateData((next) => {
                        const placement = next.placements[item.id];
                        placement.x = Math.max(
                          20,
                          placement.x +
                            (event.key === 'ArrowLeft'
                              ? -20
                              : event.key === 'ArrowRight'
                                ? 20
                                : 0),
                        );
                        placement.y = Math.max(
                          55,
                          placement.y +
                            (event.key === 'ArrowUp'
                              ? -20
                              : event.key === 'ArrowDown'
                                ? 20
                                : 0),
                        );
                      });
                    }
                  }}
                >
                  <div className="board-node-header">
                    <span>
                      {ref.kind === 'document' ? (
                        <FileText size={14} />
                      ) : (
                        <StickyNote size={14} />
                      )}
                      {ref.kind === 'document' ? 'PDF 论文' : '观点卡片'}
                    </span>
                    <Grip size={14} />
                  </div>
                  <h3>{resourceTitle(data, ref)}</h3>
                  {card && (
                    <p className="board-card-body">
                      {card.body || '还没有正文，点击在右侧编辑。'}
                    </p>
                  )}
                  {document && (
                    <div className="board-document-preview">
                      <FileText size={35} strokeWidth={1.2} />
                      <span>{document.authors}</span>
                      <small>
                        {document.year} · {document.pageCount} 页
                      </small>
                      <em>双击进入阅读器</em>
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
                        : '原始文献'}
                    </span>
                    {card && (
                      <button
                        className="board-source-button"
                        aria-label={`查看卡片原文：${card.title}`}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          source(item);
                        }}
                      >
                        <ArrowUpRight size={13} />
                        原文
                      </button>
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
                </article>
              );
            })}
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
      {(activePlacements.length > 0 || edge) && (
        <div className="board-selection-bar" aria-label="白板选中项操作">
          {activePlacements.length > 0 && (
            <>
              <span className="muted">已选 {activePlacements.length} 项</span>
              <input
                aria-label="白板分组名称"
                list={`groups-${boardId}`}
                placeholder="分组名称"
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
              />
              <datalist id={`groups-${boardId}`}>
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
                  rememberRemoval({ placements: [], edges: [edge] });
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
          {placements.length} 项资料 · {edges.length} 个关系
        </span>
        <span>Shift 多选 · 拖动移动 · 滚动平移</span>
      </div>
    </div>
  );
}
