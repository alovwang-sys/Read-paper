import type { PaneGroup, ResourceRef } from '../domain/types';

export type PaneDropSide = 'left' | 'right' | 'up' | 'down' | 'center';
export type PaneDragSource = { kind: 'tab'; scope: string; tabId: string } | { kind: 'resource'; scope: string; ref: ResourceRef };
export type PaneDropAction = { paneId: string; side: PaneDropSide; index?: number; mode: 'copy' | 'move' | 'open' | 'none'; effect: 'copy' | 'move' | 'none'; label: string };

const direction = { left: '左侧', right: '右侧', up: '上方', down: '下方', center: '这里' };

export function paneDropAction(source: PaneDragSource, groups: PaneGroup[], paneId: string, side: PaneDropSide, altKey: boolean, index?: number): PaneDropAction | undefined {
  if (!groups.some(group => group.id === paneId)) return;
  if (source.kind === 'resource') return { paneId, side, index, mode: 'open', effect: 'copy', label: side === 'center' ? '在这里打开' : `在${direction[side]}新窗格打开` };
  const origin = groups.find(group => group.tabs.some(tab => tab.id === source.tabId));
  if (!origin) return;
  const copy = altKey || origin.id === paneId && side !== 'center';
  const mode = copy ? 'copy' : origin.id === paneId && side === 'center' && index === undefined ? 'none' : 'move';
  const label = mode === 'none' ? '原位置' : mode === 'copy' ? `保留原标签，在${direction[side]}打开` : index !== undefined ? '插入到此位置' : side === 'center' ? '移动到这里' : `移动到${direction[side]}新窗格`;
  return { paneId, side, index, mode, effect: mode === 'copy' ? 'copy' : mode === 'none' ? 'none' : 'move', label };
}
