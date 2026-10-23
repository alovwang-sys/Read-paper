import React, { useLayoutEffect, useRef, useState } from 'react';
import { Excalidraw, MainMenu, convertToExcalidrawElements, exportToBlob, getCommonBounds, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import './workspace-preview-board.css';

window.EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';
let remembered;
const imageUrls = new Set();
window.addEventListener('pagehide', () => imageUrls.forEach(url => URL.revokeObjectURL(url)), { once: true });

function initialScene() {
  const cards = [
    ['retrieval', 70, 140, '检索式 B 的召回', '同义词扩展更敏感。\n还需核对相关性。'],
    ['spacing', 430, 140, '年份限制', '限定 2018 年后样本减少。\n需要在相同条件下比较。'],
    ['question', 250, 420, '原文证据', '样例论文 A 表 3 对照。\n尚待跨数据库核查。'],
  ];
  return {
    elements: convertToExcalidrawElements([
      ...cards.map(([id, x, y, title, body]) => ({
        id, type: 'rectangle', x, y, width: 260, height: 156, roughness: 0,
        backgroundColor: id === 'question' ? '#f7f3e9' : '#ffffff',
        fillStyle: 'solid', strokeColor: '#b4c5bb', strokeWidth: 1, roundness: { type: 3 },
        label: { text: `${title}\n\n${body}`, fontFamily: 2, fontSize: 16, textAlign: 'left', verticalAlign: 'middle', strokeColor: '#34473d' },
      })),
      { id: 'compare-arrow', type: 'arrow', x: 335, y: 218, width: 80, height: 0, points: [[0, 0], [80, 0]],
        start: { id: 'retrieval' }, end: { id: 'spacing' }, endArrowhead: 'arrow', strokeColor: '#72927f', roughness: 0 },
      { id: 'hand-note', type: 'text', x: 75, y: 80, text: '先对齐检索条件，再一起核查证据', fontFamily: 2, fontSize: 18, strokeColor: '#738277' },
    ], { regenerateIds: false }),
    appState: { viewBackgroundColor: '#f9faf7', currentItemFontFamily: 2, currentItemStrokeColor: '#466d58', zoom: { value: .78 }, scrollX: 10, scrollY: 0 },
    files: {},
  };
}

// Bound text belongs to its selected card; arrows never expand the selection to endpoints.
function selectedSnapshot(allElements, state) {
  const scene = allElements.filter(element => !element.isDeleted);
  const picked = scene.filter(element => state.selectedElementIds[element.id]);
  const ids = new Set(picked.map(element => element.id));
  for (const element of picked) {
    for (const bound of element.boundElements ?? []) if (bound.type === 'text') ids.add(bound.id);
  }
  const elements = structuredClone(scene.filter(element => ids.has(element.id)));
  const count = picked.filter(element => element.type !== 'text' || !ids.has(element.containerId)).length;
  return { state, ids, elements, count };
}

export default function BoardPreview({ onAsk, onSelection }) {
  const api = useRef(null);
  const host = useRef(null);
  const initial = useRef(remembered ?? initialScene());
  const countRef = useRef(0);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => api.current?.refresh());
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);

  function change(elements, state, files) {
    remembered = { elements, appState: { ...state, collaborators: new Map(), openSidebar: null }, files };
    const snapshot = selectedSnapshot(elements, state);
    if (snapshot.count !== countRef.current) {
      countRef.current = snapshot.count;
      setCount(snapshot.count);
      onSelection?.({ count: snapshot.count });
    }
  }

  async function ask() {
    if (!api.current || busy) return;
    const { state, ids, elements, count: selectedCount } = selectedSnapshot(api.current.getSceneElements(), api.current.getAppState());
    if (!elements.length) return;
    setBusy(true);
    setError('');
    try {
      const files = {};
      const allFiles = api.current.getFiles();
      for (const element of elements) {
        if (element.type === 'image' && element.fileId && allFiles[element.fileId]) files[element.fileId] = structuredClone(allFiles[element.fileId]);
      }
      const text = elements.filter(element => element.type === 'text').map(element => element.text).join('\n\n');
      const rendered = elements.map(element => ({
        ...element,
        frameId: ids.has(element.frameId) ? element.frameId : null,
        boundElements: element.boundElements?.filter(bound => ids.has(bound.id)) ?? null,
        ...('containerId' in element ? { containerId: ids.has(element.containerId) ? element.containerId : null } : {}),
        ...(element.type === 'arrow' ? {
          startBinding: ids.has(element.startBinding?.elementId) ? element.startBinding : null,
          endBinding: ids.has(element.endBinding?.elementId) ? element.endBinding : null,
        } : {}),
      }));
      const blob = await exportToBlob({
        elements: rendered, files, mimeType: 'image/png', exportPadding: 16, maxWidthOrHeight: 1600,
        appState: { exportBackground: true, exportEmbedScene: false, exportWithDarkMode: false, viewBackgroundColor: state.viewBackgroundColor },
      });
      const imageUrl = URL.createObjectURL(blob);
      imageUrls.add(imageUrl);
      const bounds = getCommonBounds(elements);
      const start = sceneCoordsToViewportCoords({ sceneX: bounds[0], sceneY: bounds[1] }, state);
      const end = sceneCoordsToViewportCoords({ sceneX: bounds[2], sceneY: bounds[3] }, state);
      onAsk?.({ title: `白板选区 · ${selectedCount} 项`, text: text || '所选内容是图形或手绘，请根据局部图片分析；没有可直接提取的文字。',
        elementIds: [...ids], imageUrl, bounds, anchor: { left: start.x, top: start.y, right: end.x, bottom: end.y }, count: selectedCount,
        hasExtractedText: Boolean(text), snapshot: elements.map(({ id, type, text: value }) => ({ id, type, ...(value ? { text: value } : {}) })) });
    } catch {
      setError('选区图片没有准备好，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return <section ref={host} className="workspace-board-preview" aria-label="可编辑研究白板" data-testid="workspace-board">
    <Excalidraw name="研究白板 · 交互演示" langCode="zh-CN" theme="light" aiEnabled={false}
      initialData={initial.current} excalidrawAPI={editor => { api.current = editor; }}
      onChange={change} handleKeyboardGlobally={false} isCollaborating={false}
      onLinkOpen={(_element, event) => event.preventDefault()} validateEmbeddable={() => false}
      onPaste={clipboard => !clipboard.elements?.some(element => ['iframe', 'embeddable'].includes(element.type))}
      UIOptions={{ canvasActions: { loadScene: false, export: false, saveToActiveFile: false, toggleTheme: false }, tools: { image: false } }}>
      <MainMenu>
        <MainMenu.DefaultItems.SaveAsImage />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ClearCanvas />
      </MainMenu>
    </Excalidraw>
    {count > 0 && <div className="workspace-board-ask" onPointerDown={event => event.stopPropagation()}>
      <button type="button" disabled={busy} onClick={ask} data-testid="ask-board-selection">{busy ? '准备选区…' : `问选中内容 · ${count} 项`}</button>
    </div>}
    {error && <p className="workspace-board-error" role="alert">{error}</p>}
  </section>;
}
