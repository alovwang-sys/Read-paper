import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { BoardPlacement, DrawingSnapshot, WorkspaceData } from '../../domain/types';
import { hasFullText } from '../../domain/knowledge';
import { drawingResearchSelection } from './board-research-selection';

type Selection = Pick<AppState, 'selectedElementIds' | 'selectedGroupIds'>;
type ResourceData = Pick<WorkspaceData, 'cards' | 'documents'>;

/** Copy the live selection before any asynchronous image export can change it. */
export function prepareDrawingQuestion(
  scene: readonly ExcalidrawElement[], selection: Selection, files: BinaryFiles,
  placements: readonly BoardPlacement[], data: ResourceData,
) {
  const ids = new Set(drawingResearchSelection(scene, selection, placements).elementIds);
  if (!ids.size) throw new Error('请先选择要问 Agent 的绘图内容。');
  if (ids.size > 100) throw new Error('选区超过 100 个元素，请缩小选区后重试。');
  const selected = structuredClone(scene.filter(element => ids.has(element.id) && !element.isDeleted));
  const imageFiles: BinaryFiles = {};
  const elements: DrawingSnapshot['elements'] = selected.map(element => {
    if (![element.x, element.y, element.width, element.height, element.angle].every(Number.isFinite)
      || element.width < 0 || element.height < 0) throw new Error('所选图形的位置或尺寸无效，请重新选择。');
    if (element.type === 'image') {
      const file = element.fileId && files[element.fileId];
      if (!file?.dataURL?.startsWith('data:image/') || element.status === 'error') throw new Error('所选图片尚未加载完整，请等待图片显示后重试。');
      imageFiles[file.id] = structuredClone(file);
    }
    let resource: DrawingSnapshot['elements'][number]['resource'];
    if (element.type === 'embeddable') {
      const placement = placements.find(item => item.id === element.customData?.placementId);
      const ref = placement?.resourceRef;
      if (!ref || (ref.kind !== 'card' && ref.kind !== 'document')) throw new Error('所选资料摆放已缺失，请修复或移出后重试。');
      if (ref.kind === 'card') {
        const card = data.cards[ref.id];
        if (!card) throw new Error('所选卡片已缺失，请修复或移出后重试。');
        resource = { ref: { ...ref }, title: card.title, body: card.body };
      } else {
        const document = data.documents[ref.id];
        if (!document) throw new Error('所选论文入口已缺失，请修复或移出后重试。');
        resource = { ref: { ...ref }, title: document.title, body: `${document.authors}${document.year ? ` · ${document.year}` : ''}\n${hasFullText(document) ? `${document.pageCount} 页` : '全文未导入'}` };
      }
    }
    return {
      id: element.id, type: element.type, x: element.x, y: element.y,
      width: element.width, height: element.height, angle: element.angle,
      ...(element.type === 'text' ? { text: element.text } : {}),
      ...(element.type === 'frame' || element.type === 'magicframe' ? { text: element.name ?? '' } : {}),
      ...(resource ? { resource } : {}),
    };
  });
  const connections: DrawingSnapshot['connections'] = selected.flatMap(element => {
    if (element.type !== 'arrow') return [];
    const start = element.startBinding?.elementId, end = element.endBinding?.elementId;
    const label = selected.filter(item => item.type === 'text' && item.containerId === element.id)
      .map(item => item.type === 'text' ? item.text : '').join('\n');
    return [{
      id: element.id,
      ...(start ? ids.has(start) ? { startId: start } : { startOutside: true } : {}),
      ...(end ? ids.has(end) ? { endId: end } : { endOutside: true } : {}),
      startArrowhead: element.startArrowhead, endArrowhead: element.endArrowhead,
      ...(label ? { label } : {}),
    }];
  });
  const textLength = elements.reduce((sum, element) => sum + (element.text?.length ?? 0)
    + (element.resource?.title.length ?? 0) + (element.resource?.body.length ?? 0), 0)
    + connections.reduce((sum, connection) => sum + (connection.label?.length ?? 0), 0);
  if (textLength > 12000) throw new Error('所选文字和资料正文超过 12,000 字符，请缩小选区或精简正文后重试。');
  // Export copies cannot pull an unselected frame, label, or endpoint back into the picture.
  const renderElements = selected.map(element => ({
    ...element,
    frameId: element.frameId && ids.has(element.frameId) ? element.frameId : null,
    boundElements: element.boundElements?.filter(bound => ids.has(bound.id)) ?? null,
    ...('containerId' in element && element.containerId && !ids.has(element.containerId) ? { containerId: null } : {}),
    ...(element.type === 'arrow' ? {
      startBinding: element.startBinding && ids.has(element.startBinding.elementId) ? element.startBinding : null,
      endBinding: element.endBinding && ids.has(element.endBinding.elementId) ? element.endBinding : null,
    } : {}),
  })) as ExcalidrawElement[];
  return { elements, connections, renderElements, files: imageFiles };
}

export async function captureDrawingQuestion(
  scene: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles,
  placements: readonly BoardPlacement[], data: ResourceData,
) {
  const prepared = prepareDrawingQuestion(scene, state, files, placements, data);
  const background = state.viewBackgroundColor;
  await Promise.all(Object.values(prepared.files).map(async file => {
    const image = new Image();
    image.src = file.dataURL;
    try { await image.decode(); }
    catch { throw new Error('所选图片无法解码，请重新导入或移出后重试。'); }
  }));
  const { convertToExcalidrawElements, exportToBlob } = await import('@excalidraw/excalidraw');
  let resourceIndex = 0;
  const renderIds = new Set(prepared.renderElements.map(element => element.id));
  const renderElements = prepared.renderElements.flatMap<ExcalidrawElement>(element => {
    if (element.type !== 'embeddable') return [element];
    const resource = prepared.elements.find(item => item.id === element.id)!.resource!;
    let labelId = `question-label-${element.id}`;
    while (renderIds.has(labelId)) labelId += '-copy';
    renderIds.add(labelId);
    const label = { id: labelId, text: `${resource.ref.kind === 'card' ? '卡片' : '论文'} ${++resourceIndex}\n文字另附`, fontFamily: 2, fontSize: 16, strokeColor: '#46573d' };
    // Native exports omit React card bodies. Label a placeholder and send its full text separately.
    return convertToExcalidrawElements([{
      type: 'rectangle', id: element.id, x: element.x, y: element.y,
      width: element.width, height: element.height, angle: element.angle,
      strokeColor: '#ccd9c4', backgroundColor: '#fffefa', fillStyle: 'solid', roughness: 0,
      label,
    }], { regenerateIds: false });
  });
  const image = await exportToBlob({
    elements: renderElements.filter(element => !element.isDeleted) as (ExcalidrawElement & { isDeleted: false })[],
    files: prepared.files, mimeType: 'image/png', maxWidthOrHeight: 2048, exportPadding: 12,
    appState: { exportBackground: true, exportScale: 1, exportEmbedScene: false, exportWithDarkMode: false, viewBackgroundColor: background },
  });
  if (image.size > 2 * 1024 * 1024) throw new Error('所选图片超过 2 MiB，请缩小选区后重试。');
  const header = new DataView(await image.slice(0, 24).arrayBuffer());
  if (header.byteLength < 24 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a)
    throw new Error('选区图片导出失败，请重新选择后重试。');
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || Math.max(width, height) > 2048) throw new Error('选区图片尺寸无效，请缩小选区后重试。');
  return { image, width, height, elements: prepared.elements, connections: prepared.connections };
}
