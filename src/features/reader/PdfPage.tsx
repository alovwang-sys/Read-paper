import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { Evidence } from '../../domain/types';

export type PageSize = { width: number; height: number; scale: number; rotation: number };
export type PageHandle = { canvas: HTMLCanvasElement; layer: HTMLDivElement; size: PageSize; rendering: boolean; textReady: boolean };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

export function PdfPage({ pdf, documentId, title, pageIndex, size, active, selectionMode, excerpts, source, retry, onUpdate, onTextError, onError, onSelect, onExcerptClick, children }: {
  pdf: PDFDocumentProxy; documentId: string; title: string; pageIndex: number; size: PageSize; active: boolean;
  selectionMode: 'text' | 'region'; excerpts: Evidence[]; source?: Evidence; retry: number;
  onUpdate: (handle?: PageHandle) => void; onTextError: () => void; onError: (message: string) => void;
  onSelect: () => void; onExcerptClick: (element: HTMLElement) => void; children: ReactNode;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onUpdate, onTextError, onError });
  callbacks.current = { onUpdate, onTextError, onError };
  const [rendering, setRendering] = useState(true);
  const [textReady, setTextReady] = useState(false);

  useEffect(() => {
    if (!active || !canvas.current || !layer.current) return;
    let live = true;
    let task: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const node = canvas.current, textContainer = layer.current;
    const update = (rendering: boolean, textReady: boolean) => {
      if (!live) return;
      setRendering(rendering); setTextReady(textReady);
      callbacks.current.onUpdate({ canvas: node, layer: textContainer, size, rendering, textReady });
    };
    update(true, false);
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
      update(false, false);
      try {
        const content = await page.getTextContent();
        if (!live) return;
        if (content.items.some(item => 'str' in item && item.str.trim())) {
          textLayer = new TextLayer({ textContentSource: content, container: textContainer, viewport });
          await textLayer.render();
          update(false, true);
        }
      } catch { if (live) callbacks.current.onTextError(); }
    })().catch(error => {
      if (!live || error?.name === 'RenderingCancelledException') return;
      update(false, false);
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

  useEffect(() => {
    if (!textReady || !layer.current) return;
    const spans = [...layer.current.querySelectorAll<HTMLSpanElement>('span')].filter(span => span.textContent?.trim());
    for (const span of spans) { span.classList.remove('pdf-excerpt-highlight', 'pdf-source-highlight'); delete span.dataset.evidenceId; }
    const texts = spans.map(span => normalize(span.textContent ?? '')), fullText = texts.join(' ');
    function highlight(quote: string, className: string, evidenceId?: string) {
      const selected = normalize(quote), start = fullText.indexOf(selected);
      if (!selected || start < 0) return;
      let offset = 0;
      spans.forEach((span, index) => {
        const end = offset + texts[index].length;
        if (end > start && offset < start + selected.length) { span.classList.add(className); if (evidenceId) span.dataset.evidenceId = evidenceId; }
        offset = end + 1;
      });
    }
    for (const item of excerpts) if (item.kind !== 'region') highlight(item.quote, 'pdf-excerpt-highlight', item.id);
    if (source?.kind !== 'region' && source?.quote) highlight(source.quote, 'pdf-source-highlight', source.id);
  }, [textReady, excerpts, source?.id, source?.quote]);

  return <div className={`pdf-sheet ${active ? '' : 'pdf-sheet-placeholder'}`} style={{ width: size.width, height: size.height, '--total-scale-factor': size.scale, '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties} data-document-id={documentId} data-page-index={pageIndex}>
    {active ? <>
      <canvas ref={canvas} aria-label={`${title} PDF 第 ${pageIndex + 1} 页`} />
      <div ref={layer} className={`pdf-text-layer ${selectionMode === 'region' ? 'pdf-text-layer-inactive' : ''}`} onMouseUp={onSelect} onKeyUp={onSelect} onClick={event => onExcerptClick(event.target as HTMLElement)} />
      {children}
      {rendering && <div className="pdf-page-loading"><LoaderCircle size={22} className="pdf-spinner" /></div>}
    </> : <span className="pdf-page-placeholder-label">PDF 第 {pageIndex + 1} 页</span>}
  </div>;
}
