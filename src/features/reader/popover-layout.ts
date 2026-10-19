export type PopoverRect = { left: number; top: number; width: number; height: number };

export function constrainPopover(rect: PopoverRect, viewport: { width: number; height: number }, minimum = { width: 0, height: 0 }): PopoverRect {
  const availableWidth = Math.max(1, viewport.width - 16), availableHeight = Math.max(1, viewport.height - 16);
  const width = Math.min(availableWidth, Math.max(minimum.width, rect.width));
  const height = Math.min(availableHeight, Math.max(minimum.height, rect.height));
  return { width, height, left: Math.max(8, Math.min(rect.left, viewport.width - 8 - width)), top: Math.max(8, Math.min(rect.top, viewport.height - 8 - height)) };
}
