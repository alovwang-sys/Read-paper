import { describe, expect, it } from 'vitest';
import type { PaneGroup } from '../../src/domain/types';
import { paneDropAction, type PaneDropSide } from '../../src/shell/pane-drag';

const group = (id: string, ...tabs: string[]): PaneGroup => ({ kind: 'group', id, activeTabId: tabs[0], tabs: tabs.map(tab => ({ id: tab, ref: { kind: 'document', id: 'same-document' } })) });
const source = { kind: 'tab', scope: 'research', tabId: 'a' } as const;

describe('pane drag intent', () => {
  it.each([1, 2, 4])('copies at its own edges with %i tabs', count => {
    const groups = [group('left', ...['a', 'b', 'c', 'd'].slice(0, count)), group('right', 'e')];
    for (const side of ['left', 'right', 'up', 'down'] as PaneDropSide[]) {
      expect(paneDropAction(source, groups, 'left', side, false)).toMatchObject({ mode: 'copy', effect: 'copy' });
    }
  });

  it('leaves its own body unchanged but keeps tab-bar reordering', () => {
    const groups = [group('left', 'a', 'b')];
    expect(paneDropAction(source, groups, 'left', 'center', false)).toMatchObject({ mode: 'none', effect: 'none', label: '原位置' });
    expect(paneDropAction(source, groups, 'left', 'center', false, 2)).toMatchObject({ mode: 'move', index: 2, label: '插入到此位置' });
    expect(paneDropAction(source, groups, 'left', 'center', true)).toMatchObject({ mode: 'copy', effect: 'copy' });
  });

  it('moves across groups and copies with Option', () => {
    const groups = [group('left', 'a'), group('right', 'b')];
    for (const side of ['center', 'left', 'right', 'up', 'down'] as PaneDropSide[]) {
      expect(paneDropAction(source, groups, 'right', side, false)).toMatchObject({ mode: 'move', effect: 'move' });
      expect(paneDropAction(source, groups, 'right', side, true)).toMatchObject({ mode: 'copy', effect: 'copy' });
    }
  });

  it('opens a resource without moving its source list', () => {
    const groups = [group('left', 'a')];
    const resource = { kind: 'resource', scope: 'research', ref: { kind: 'card', id: 'card-a' } } as const;
    expect(paneDropAction(resource, groups, 'left', 'right', false)).toMatchObject({ mode: 'open', effect: 'copy', label: '在右侧新窗格打开' });
    expect(paneDropAction(resource, groups, 'left', 'center', false)).toMatchObject({ mode: 'open', label: '在这里打开' });
  });

  it('rejects missing source tabs and vanished destinations', () => {
    expect(paneDropAction(source, [group('left', 'b')], 'left', 'right', false)).toBeUndefined();
    expect(paneDropAction(source, [group('left', 'a')], 'missing', 'right', false)).toBeUndefined();
  });
});
