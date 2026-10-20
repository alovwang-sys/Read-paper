import { useEffect, useId, useMemo, useState, type RefObject } from 'react';
import type { BoardEdge, BoardPlacement } from '../../domain/types';
import { boardConnection } from './connection-geometry';
import './board-connections.css';

type Props = {
  placements: BoardPlacement[];
  edges: BoardEdge[];
  selectedEdge?: string;
  onSelectEdge: (id: string) => void;
  width: number;
  height: number;
  sizes: Record<string, { width: number; height: number }>;
  structural?: boolean;
  showRelations?: boolean;
  selectedPlacements?: string[];
};

export function useBoardNodeSizes(placements: BoardPlacement[], nodeRefs: RefObject<Record<string, HTMLElement | null>>) {
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});
  const placementKey = placements.map(item => item.id).join('\0');
  useEffect(() => {
    const nodes = placementKey.split('\0').map(id => ({ id, element: nodeRefs.current[id] })).filter(item => item.element);
    const measure = () => {
      const next = Object.fromEntries(nodes.map(({ id, element }) => [id, { width: element!.offsetWidth, height: element!.offsetHeight }]));
      setSizes(current => Object.keys(current).length === nodes.length && nodes.every(({ id }) => current[id]?.width === next[id].width && current[id]?.height === next[id].height) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    nodes.forEach(({ element }) => observer.observe(element!));
    return () => observer.disconnect();
  }, [nodeRefs, placementKey]);
  return sizes;
}

export function BoardConnections({ placements, edges, selectedEdge, onSelectEdge, width, height, sizes, structural = false, showRelations = true, selectedPlacements = [] }: Props) {
  const arrowId = `connection-arrow-${useId()}`;
  const byId = new Map(placements.map(item => [item.id, item]));
  const selectedIds = new Set(selectedPlacements);
  const geometries = useMemo(() => {
    const boxes = new Map(placements.map(item => [item.id, { ...item, ...(sizes[item.id] ?? { width: 260, height: structural ? 100 : 215 }) }]));
    return new Map((showRelations ? edges : []).flatMap(edge => {
      const from = boxes.get(edge.fromPlacementId), to = boxes.get(edge.toPlacementId);
      if (!from || !to || from.boardId !== edge.boardId || to.boardId !== edge.boardId) return [];
      return [[edge.id, boardConnection(from, to, [...boxes.values()].filter(box => box.id !== from.id && box.id !== to.id))]];
    }));
  }, [placements, edges, sizes, structural, showRelations]);
  return <svg className={`board-edges board-connections${structural ? ' is-structural' : ''}`} width={width} height={height} aria-label={structural ? '层级与关联' : '论证关系'}>
    <defs>
      {[false, true].map(selected => <marker key={String(selected)} id={`${arrowId}${selected ? '-selected' : ''}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto" markerUnits="userSpaceOnUse">
        <path className={selected ? 'connection-arrow is-selected' : 'connection-arrow'} d="M 1 1 L 9 5 L 1 9 L 3 5 Z" />
      </marker>)}
    </defs>
    {structural && placements.map(child => {
      const parent = child.parentPlacementId && byId.get(child.parentPlacementId);
      if (!parent || parent.boardId !== child.boardId) return null;
      // Tree ports stay in the gap between columns, even for very tall branches.
      const startX = parent.x + (sizes[parent.id]?.width ?? 260), endX = child.x;
      const startY = parent.y + (sizes[parent.id]?.height ?? 100) / 2, endY = child.y + (sizes[child.id]?.height ?? 100) / 2;
      const middle = (startX + endX) / 2;
      return <path key={`parent-${child.id}`} data-parent-id={parent.id} data-child-id={child.id}
        className={`board-structure-stroke${selectedIds.has(parent.id) || selectedIds.has(child.id) ? ' is-related' : ''}`}
        d={`M ${startX} ${startY} C ${middle} ${startY}, ${middle} ${endY}, ${endX} ${endY}`} vectorEffect="non-scaling-stroke" aria-hidden="true" />;
    })}
    {showRelations && edges.map(edge => {
      const geometry = geometries.get(edge.id);
      if (!geometry) return null;
      const characters = Array.from(edge.label.trim() || '添加说明'), selected = edge.id === selectedEdge;
      const related = selected || selectedIds.has(edge.fromPlacementId) || selectedIds.has(edge.toPlacementId);
      const textWidth = (value: string[]) => value.reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 10 : 6), 20);
      const shortened = [...characters];
      while (shortened.length && textWidth(shortened) + (shortened.length < characters.length ? 10 : 0) > geometry.labelMaxWidth) shortened.pop();
      const label = shortened.length < characters.length ? [...shortened, '…'] : shortened;
      const labelWidth = textWidth(label);
      return <g key={edge.id} data-edge-id={edge.id} className={`board-edge${selected ? ' is-selected' : ''}${related ? ' is-related' : selectedIds.size ? ' is-muted' : ''}${edge.label.trim() ? '' : ' is-unlabelled'}`} role="button" tabIndex={0} aria-label={`编辑关系：${edge.label || '未命名'}`} aria-pressed={selected}
        onPointerDown={event => event.stopPropagation()}
        onClick={() => onSelectEdge(edge.id)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); onSelectEdge(edge.id); } }}>
        <title>{edge.label || '点击连线添加关系说明'}</title>
        <path className="board-connection-stroke" d={geometry.path} markerEnd={`url(#${arrowId}${selected ? '-selected' : ''})`} vectorEffect="non-scaling-stroke" />
        <path className="board-edge-hit" d={geometry.path} vectorEffect="non-scaling-stroke" />
        {geometry.labelMaxWidth >= 30 && <g className="board-connection-label">
          <rect x={geometry.label.x - labelWidth / 2} y={geometry.label.y - 13} width={labelWidth} height={26} rx={13} />
          <text x={geometry.label.x} y={geometry.label.y} textAnchor="middle" dominantBaseline="central">{label.join('')}</text>
        </g>}
      </g>;
    })}
  </svg>;
}
