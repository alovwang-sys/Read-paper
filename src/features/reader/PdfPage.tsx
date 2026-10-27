import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { Evidence } from '../../domain/types';
import { rangeForTextAnchor } from './text-anchor';

export type PageSize = { width: number; height: number; scale: number; rotation: number };
export type PageTextState = 'pending' | 'ready' | 'empty' | 'error';
export type PageHandle = { canvas: HTMLCanvasElement; layer: HTMLDivElement; size: PageSize; rendering: boolean; textReady: boolean; textState: PageTextState };
type Mark = { id: string; source: boolean; contextOnly: boolean; rectangles: Array<{ left: number; top: number; width: number; height: number }> };

export function PdfPage({ pdf, documentId, title, pageIndex, size, active, selectionMode, excerpts, source, activityCounts, retry, onUpdate, onTextError, onError, onSelect, onExcerptClick, children }: {
  pdf: PDFDocumentProxy; documentId: string; title: string; pageIndex: number; size: PageSize; active: boolean;
  selectionMode: 'text' | 'region'; excerpts: Evidence[]; source?: Evidence; retry: number;
  activityCounts?: Record<string, number>;
  onUpdate: (handle?: PageHandle) => void; onTextError: () => void; onError: (message: string) => void;
  onSelect: () => void; onExcerptClick: (element: HTMLElement) => void; children: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onUpdate, onTextError, onError });
  callbacks.current = { onUpdate, onTextError, onError };
  const [rendering, setRendering] = useState(true);
  const [textReady, setTextReady] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const markSignature = JSON.stringify([excerpts.map(item => [item.id, item.quote, item.textAnchor, item.contextOnly, item.kind]), source && [source.id, source.quote, source.textAnchor, source.contextOnly, source.kind]]);

  useEffect(() => {
    if (!active || !canvas.current || !layer.current) return;
    let live = true;
    let task: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const node = canvas.current, textContainer = layer.current;
    const update = (rendering: boolean, textState: PageTextState) => {
      if (!live) return;
      const textReady = textState === 'ready';
      setRendering(rendering); setTextReady(textReady);
      callbacks.current.onUpdate({ canvas: node, layer: textContainer, size, rendering, textReady, textState });
    };
    update(true, 'pending');
    textContainer.replaceChildren();
    (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      if (!live) return;
      const viewport = page.getViewport({ scale: size.scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      node.width = Math.floor(viewport.width * pixelRatio);
      node.height = Math.floor(viewport.height * pixelRatio);
      node.style.width = `${viewport.width}px`; node.style.height = `${viewport.height}px`;
      task = page.render({ canvas: node, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await task.promise;
      if (!live) return;
      update(false, 'pending');
      try {
        const content = await page.getTextContent();
        if (!live) return;
        if (content.items.some(item => 'str' in item && item.str.trim())) {
          textLayer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
          await textLayer.render();
          update(false, 'ready');
        } else update(false, 'empty');
      } catch { if (live) { update(false, 'error'); callbacks.current.onTextError(); } }
    })().catch(error => {
      if (!live || error?.name === 'RenderingCancelledException') return;
      update(false, 'error');
      callbacks.current.onError(`此页无法渲染：${error instanceof Error ? error.message : '请重试'}`);
    });
    return () => {
      live = false;
      task?.cancel(); textLayer?.cancel();
      callbacks.current.onUpdate();
      // Release off-screen backing pixels while the page placeholder keeps its height.
      node.width = 0; node.height = 0;
    };
  }, [pdf, pageIndex, size.width, size.height, size.scale, active, retry]);

  useLayoutEffect(() => {
    if (!textReady || !layer.current || !active) { setMarks([]); return; }
    const node = layer.current, bounds = node.getBoundingClientRect();
    const items = [...new Map([...excerpts, ...(source ? [source] : [])].map(item => [item.id, item])).values()];
    setMarks(items.filter(item => item.kind !== 'region').flatMap(item => {
      const range = rangeForTextAnchor(node, item.quote, item.textAnchor);
      if (!range) return [];
      const rectangles = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => ({
        left: rect.left - bounds.left, top: rect.top - bounds.top, width: rect.width, height: rect.height,
      }));
      return rectangles.length ? [{ id: item.id, source: source?.id === item.id, contextOnly: !!item.contextOnly, rectangles }] : [];
    }));
  }, [textReady, active, size.width, size.height, markSignature]);

  return <div className={`pdf-sheet ${active ? '' : 'pdf-sheet-placeholder'}`} style={{ width: size.width, height: size.height, '--total-scale-factor': size.scale, '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties} data-document-id={documentId} data-page-index={pageIndex}>
    {active ? <>
      <canvas ref={canvas} aria-label={`${title} PDF 第 ${pageIndex + 1} 页`} />
      <div ref={layer} className={`pdf-text-layer ${selectionMode === 'region' ? 'pdf-text-layer-inactive' : ''}`} onMouseUp={onSelect} onKeyUp={onSelect} onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect(), x = event.clientX - bounds.left, y = event.clientY - bounds.top;
        const hits = marks.filter(item => item.rectangles.some(rect => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height));
        const mark = hits.find(item => item.source) ?? hits[0];
        const marked = mark && event.currentTarget.parentElement?.querySelector<HTMLElement>(`.pdf-exact-highlight[data-evidence-id="${CSS.escape(mark.id)}"]`);
        onExcerptClick(marked || event.target as HTMLElement);
      }} />
      <div className="pdf-annotation-layer" aria-label="原文操作标记">
        {marks.map(mark => <div key={mark.id}>
          {mark.rectangles.map((rect, index) => <span key={index} data-evidence-id={mark.id}
            className={`pdf-exact-highlight ${mark.contextOnly ? 'pdf-activity-highlight' : 'pdf-excerpt-highlight'} ${mark.source ? 'pdf-exact-source pdf-source-highlight' : ''}`} style={rect} />)}
          {excerpts.some(item => item.id === mark.id) && <button className="pdf-activity-marker" data-evidence-id={mark.id}
            aria-label={`查看此处记录 · ${activityCounts?.[mark.id] || 1}条`} title="查看此处的提问、翻译和卡片"
            style={{ top: mark.rectangles[0].top, left: Math.min(size.width - 27, Math.max(0, mark.rectangles[0].left + mark.rectangles[0].width + 3)) }}
            onMouseDown={event => event.preventDefault()} onClick={event => { window.getSelection()?.removeAllRanges(); onExcerptClick(event.currentTarget); }}>
            {activityCounts?.[mark.id] || 1}
          </button>}
        </div>)}
      </div>
      {children}
      {rendering && <div className="pdf-page-loading"><LoaderCircle size={22} className="pdf-spinner" /></div>}
    </> : <span className="pdf-page-placeholder-label">PDF 第 {pageIndex + 1} 页</span>}
  </div>;
}
