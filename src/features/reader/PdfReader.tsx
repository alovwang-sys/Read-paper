import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Layers,
  List,
  LoaderCircle,
  Minus,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { ResourceAnchor } from '../../domain/types';
import { scopeKey, useWorkspace } from '../../services/workspace';
import { loadPdfDocument } from '../../services/pdf';
import { ImportPDFButton } from './ImportPDFButton';
import './reader.css';

type Outline = { title: string; pageIndex: number; depth: number };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

export function PdfReader({
  documentId,
  target = 'main',
  anchor,
}: {
  documentId: string;
  target?: 'main' | 'inspector';
  anchor?: ResourceAnchor;
}) {
  const { data, session, research, actions } = useWorkspace();
  const doc = data.documents[documentId];
  const position = session.readers[`${target}:${documentId}`] ?? {
    pageIndex: 0,
    scale: 1,
  };
  const pageIndex = Math.min(
    position.pageIndex,
    Math.max(0, (doc?.pageCount ?? 1) - 1),
  );
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [textRetry, setTextRetry] = useState(0);
  const [rendering, setRendering] = useState(true);
  const [textState, setTextState] = useState<
    'pending' | 'ready' | 'empty' | 'error'
  >('pending');
  const [pageTextReady, setPageTextReady] = useState(false);
  const [pagesText, setPagesText] = useState<string[]>([]);
  const [outline, setOutline] = useState<Outline[]>([]);
  const [showNavigation, setShowNavigation] = useState(false);
  const [search, setSearch] = useState('');
  const [quote, setQuote] = useState('');
  const [width, setWidth] = useState(target === 'main' ? 720 : 320);
  const [pageSize, setPageSize] = useState({
    width: 612,
    height: 792,
    scale: 1,
  });
  const scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const viewScope = scopeKey(data.scope);
  const sourceEvidence = anchor?.evidenceId
    ? data.evidence[anchor.evidenceId]
    : undefined;
  const sourceValid =
    !!sourceEvidence &&
    sourceEvidence.documentId === documentId &&
    sourceEvidence.pageIndex >= 0 &&
    sourceEvidence.pageIndex < (doc?.pageCount ?? 0);

  useEffect(() => {
    let active = true;
    setPdf(undefined);
    setError('');
    setQuote('');
    setRendering(true);
    setPagesText([]);
    setOutline([]);
    if (!doc) return;
    loadPdfDocument(doc, retry > 0)
      .then(({ pdf, hash }) => {
        if (!active) return;
        setPdf(pdf);
        actions.updateData((data) => {
          const current = data.documents[documentId];
          if (!current) return;
          current.hash = hash;
          current.pageCount = pdf.numPages;
          if (current.readingStatus === 'unread')
            current.readingStatus = 'reading';
        });
      })
      .catch((error) => {
        if (active) {
          setRendering(false);
          setError(
            error instanceof Error ? error.message : 'PDF 加载失败，请重试。',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [documentId, doc?.assetId, doc?.assetRevision, retry]);

  useEffect(() => {
    setQuote('');
  }, [documentId, target, viewScope]);

  useEffect(() => {
    if (!pdf || !scroll.current) return;
    const update = () => setWidth(scroll.current!.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(scroll.current);
    update();
    return () => observer.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (!pdf) return;
    let active = true;
    setTextState('pending');
    const update = (status: typeof textState) => {
      if (!active) return;
      setTextState(status);
      actions.updateData((data) => {
        if (data.documents[documentId])
          data.documents[documentId].textStatus = status;
      });
    };
    (async () => {
      const texts: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        if (!active) return;
        texts.push(
          normalize(
            content.items
              .map((item) => ('str' in item ? item.str : ''))
              .join(' '),
          ),
        );
      }
      if (!active) return;
      setPagesText(texts);
      update(texts.some(Boolean) ? 'ready' : 'empty');
    })().catch(() => update('error'));
    return () => {
      active = false;
    };
  }, [pdf, textRetry]);

  useEffect(() => {
    if (!pdf) return;
    let active = true;
    (async () => {
      const flattened: Outline[] = [];
      async function visit(
        items: NonNullable<Awaited<ReturnType<PDFDocumentProxy['getOutline']>>>,
        depth: number,
      ) {
        for (const item of items) {
          const destination =
            typeof item.dest === 'string'
              ? await pdf!.getDestination(item.dest)
              : item.dest;
          if (destination) {
            const page =
              typeof destination[0] === 'number'
                ? destination[0]
                : await pdf!.getPageIndex(destination[0]);
            flattened.push({ title: item.title, pageIndex: page, depth });
          }
          if (item.items.length) await visit(item.items, depth + 1);
        }
      }
      const items = await pdf.getOutline();
      if (items) await visit(items, 0);
      if (active) setOutline(flattened);
    })().catch(() => {
      if (active) setOutline([]);
    });
    return () => {
      active = false;
    };
  }, [pdf]);

  useEffect(() => {
    if (!pdf || !canvas.current || !layer.current || width < 1) return;
    let active = true;
    let task: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    setRendering(true);
    setPageTextReady(false);
    setQuote('');
    if (
      actions.getState().selection?.viewInstanceId ===
      `reader:${viewScope}:${target}:${documentId}`
    )
      actions.setSelection(undefined);
    const textContainer = layer.current;
    textContainer.replaceChildren();
    scroll.current?.scrollTo({ top: 0, left: 0 });
    (async () => {
      const page = await pdf.getPage(pageIndex + 1);
      if (!active) return;
      const natural = page.getViewport({ scale: 1 });
      const fit = Math.max(
        0.2,
        Math.min(1.5, (width - (target === 'main' ? 56 : 24)) / natural.width),
      );
      const viewport = page.getViewport({ scale: fit * position.scale });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const node = canvas.current!;
      node.width = Math.floor(viewport.width * pixelRatio);
      node.height = Math.floor(viewport.height * pixelRatio);
      node.style.width = `${viewport.width}px`;
      node.style.height = `${viewport.height}px`;
      setPageSize({
        width: viewport.width,
        height: viewport.height,
        scale: viewport.scale,
      });
      task = page.render({
        canvas: node,
        viewport,
        transform:
          pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await task.promise;
      if (!active) return;
      setRendering(false);
      try {
        const content = await page.getTextContent();
        if (!active) return;
        const hasText = content.items.some(
          (item) => 'str' in item && item.str.trim(),
        );
        if (hasText) {
          textLayer = new TextLayer({
            textContentSource: content,
            container: textContainer,
            viewport,
          });
          await textLayer.render();
          if (!active) return;
          setPageTextReady(true);
          if (sourceValid && sourceEvidence.pageIndex === pageIndex) {
            const selected = normalize(sourceEvidence.quote);
            for (const div of textLayer.textDivs)
              if (
                normalize(div.textContent ?? '') &&
                selected.includes(normalize(div.textContent ?? ''))
              )
                div.classList.add('pdf-source-highlight');
          }
        }
      } catch {
        if (active) {
          setTextState('error');
          actions.updateData((data) => {
            if (data.documents[documentId])
              data.documents[documentId].textStatus = 'error';
          });
        }
      }
    })().catch((error) => {
      if (!active || error?.name === 'RenderingCancelledException') return;
      setRendering(false);
      setError(
        `此页无法渲染：${error instanceof Error ? error.message : '请重试'}`,
      );
    });
    return () => {
      active = false;
      task?.cancel();
      textLayer?.cancel();
    };
  }, [
    pdf,
    pageIndex,
    position.scale,
    width,
    target,
    textRetry,
    anchor?.evidenceId,
    viewScope,
  ]);

  function changePage(next: number) {
    actions.setSelection(undefined);
    actions.setReader(
      documentId,
      { pageIndex: next, scale: position.scale },
      target,
    );
  }
  function captureSelection() {
    const selection = window.getSelection();
    if (!pageTextReady || !selection?.rangeCount || !layer.current) return;
    const range = selection.getRangeAt(0);
    if (
      !layer.current.contains(range.startContainer) ||
      !layer.current.contains(range.endContainer)
    )
      return;
    const selected = normalize(selection.toString());
    if (!selected) {
      setQuote('');
      actions.setSelection(undefined);
      return;
    }
    if (selected.length > 8000) {
      actions.notice('请选择较短的原文段落（最多 8000 字符）。');
      return;
    }
    setQuote(selected);
    actions.setSelection({
      scope: data.scope,
      viewInstanceId: `reader:${viewScope}:${target}:${documentId}`,
      selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }],
      textRange: { documentId, pageIndex, quote: selected },
      evidenceIds: [],
    });
  }
  function saveSelection(mode: 'card' | 'ai') {
    if (!quote || !pageTextReady) return;
    try {
      const evidenceId = actions.createEvidence({
        documentId,
        pageIndex,
        quote,
      });
      if (mode === 'ai')
        actions.contextFromEvidence(
          actions.getState().data.evidence[evidenceId],
        );
      else {
        const cardId = actions.createCard([evidenceId], '新的观点', '');
        actions.openResource(
          { kind: 'card', id: cardId },
          { scope: data.scope, target: 'inspector' },
        );
      }
      setQuote('');
      window.getSelection()?.removeAllRanges();
      actions.setSelection(undefined);
    } catch (error) {
      actions.notice(
        error instanceof Error ? error.message : '创建证据失败，请重试。',
      );
    }
  }
  if (!doc)
    return (
      <div className="empty-state">
        <BookOpen size={28} />
        <h3>论文不存在</h3>
        <p>请从论文库重新打开或导入。</p>
        <ImportPDFButton />
      </div>
    );
  if (error)
    return (
      <div className="empty-state pdf-error" role="alert">
        <FileText size={30} />
        <h3>PDF 暂时无法打开</h3>
        <p>{error}</p>
        <div className="pdf-recovery-actions">
          <button
            className="button"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RotateCw size={14} />
            重试加载
          </button>
          <ImportPDFButton />
        </div>
      </div>
    );
  const query = normalize(search).toLowerCase();
  const results = query
    ? pagesText
        .map((text, index) => ({
          text,
          index,
          match: text.toLowerCase().indexOf(query),
        }))
        .filter((item) => item.match >= 0)
    : [];
  return (
    <section
      className={`pdf-reader pdf-reader-${target}`}
      aria-label={`PDF 阅读器 ${target === 'main' ? '主区' : '参考面板'}`}
    >
      <div className="pdf-toolbar">
        <button
          className={`icon-button ${showNavigation ? 'active' : ''}`}
          aria-label="目录与全文搜索"
          title="目录与全文搜索"
          onClick={() => setShowNavigation((value) => !value)}
        >
          <List size={16} />
        </button>
        <div className="pdf-pages">
          <button
            className="icon-button"
            aria-label="上一页"
            disabled={pageIndex === 0}
            onClick={() => changePage(pageIndex - 1)}
          >
            <ChevronLeft size={16} />
          </button>
          <label className="pdf-page-input">
            <input
              aria-label="PDF 页码"
              type="number"
              min={1}
              max={doc.pageCount}
              value={pageIndex + 1}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (
                  Number.isInteger(next) &&
                  next >= 1 &&
                  next <= doc.pageCount
                )
                  changePage(next - 1);
              }}
            />
            <span>/ {doc.pageCount}</span>
          </label>
          <button
            className="icon-button"
            aria-label="下一页"
            disabled={pageIndex >= doc.pageCount - 1}
            onClick={() => changePage(pageIndex + 1)}
          >
            <ChevronRight size={16} />
          </button>
        </div>
        <div className="pdf-zoom">
          <button
            className="icon-button"
            aria-label="缩小 PDF"
            disabled={position.scale <= 0.5}
            onClick={() =>
              actions.setReader(
                documentId,
                { pageIndex, scale: position.scale - 0.25 },
                target,
              )
            }
          >
            <Minus size={14} />
          </button>
          <button
            className="text-button"
            title="恢复适合宽度"
            onClick={() =>
              actions.setReader(documentId, { pageIndex, scale: 1 }, target)
            }
          >
            {Math.round(position.scale * 100)}%
          </button>
          <button
            className="icon-button"
            aria-label="放大 PDF"
            disabled={position.scale >= 2}
            onClick={() =>
              actions.setReader(
                documentId,
                { pageIndex, scale: position.scale + 0.25 },
                target,
              )
            }
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="pdf-status">
        <span>
          {pdf ? (rendering ? '页面渲染中…' : '阅读就绪') : '正在加载原文件…'}
        </span>
        <span>
          {textState === 'pending'
            ? '正在提取文本…'
            : textState === 'ready'
              ? '文本已就绪 · 可选择原文'
              : textState === 'empty'
                ? '扫描件 · 暂无文本层'
                : '文本提取失败'}
        </span>
      </div>
      {textState === 'error' && (
        <div className="pdf-text-notice" role="alert">
          文本提取失败，仍可阅读页面。
          <button
            className="text-button"
            onClick={() => setTextRetry((value) => value + 1)}
          >
            重试文本提取
          </button>
        </div>
      )}
      {textState === 'empty' && (
        <div className="pdf-text-notice">
          此 PDF 没有文本层，可阅读图像；原文选区和 AI 摘录暂不可用。OCR
          将在后续支持。
        </div>
      )}
      {sourceValid && (
        <div className="pdf-anchor-quote">
          <span>来源 · PDF 第 {sourceEvidence.pageIndex + 1} 页</span>
          <blockquote>{sourceEvidence.quote}</blockquote>
        </div>
      )}
      {anchor?.evidenceId && !sourceValid && (
        <div className="pdf-text-notice" role="alert">
          来源引用已缺失或不属于此论文，无法定位。请恢复正确的证据。
        </div>
      )}
      {showNavigation && (
        <div className="pdf-navigation">
          <label className="pdf-search">
            <Search size={14} />
            <input
              aria-label="搜索 PDF 全文"
              value={search}
              placeholder="搜索 PDF 全文"
              onChange={(event) => setSearch(event.target.value)}
            />
            <button
              className="icon-button"
              aria-label="关闭目录与搜索"
              onClick={() => setShowNavigation(false)}
            >
              <X size={13} />
            </button>
          </label>
          {query ? (
            <div className="pdf-search-results">
              {textState === 'pending' ? (
                <p>文本提取完成后即可搜索。</p>
              ) : textState === 'error' ? (
                <p>请先重试文本提取。</p>
              ) : !results.length ? (
                <p>没有找到“{search}”。</p>
              ) : (
                results.map((item) => (
                  <button
                    key={item.index}
                    onClick={() => changePage(item.index)}
                  >
                    <strong>PDF 第 {item.index + 1} 页</strong>
                    <span>
                      …
                      {item.text.slice(
                        Math.max(0, item.match - 40),
                        item.match + query.length + 80,
                      )}
                      …
                    </span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="pdf-outline">
              <strong>目录</strong>
              {outline.length ? (
                outline.map((item, index) => (
                  <button
                    key={index}
                    style={{ paddingLeft: `${12 + item.depth * 12}px` }}
                    onClick={() => changePage(item.pageIndex)}
                  >
                    {item.title}
                    <span>{item.pageIndex + 1}</span>
                  </button>
                ))
              ) : (
                <p>此论文未嵌入目录，可直接输入页码定位。</p>
              )}
            </div>
          )}
        </div>
      )}
      {quote && (
        <div
          className="pdf-selection-menu"
          role="toolbar"
          aria-label="原文选区操作"
          onMouseDown={(event) => event.preventDefault()}
        >
          <span>{quote.length} 字符已选</span>
          <button className="primary" onClick={() => saveSelection('card')}>
            <Layers size={14} />
            创建证据卡片
          </button>
          {research && (
            <button className="button" onClick={() => saveSelection('ai')}>
              <Sparkles size={14} />
              加入 AI 上下文
            </button>
          )}
          <button
            className="icon-button"
            aria-label="取消原文选区"
            onClick={() => {
              setQuote('');
              actions.setSelection(undefined);
              window.getSelection()?.removeAllRanges();
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="pdf-scroll" ref={scroll}>
        {!pdf && (
          <div className="pdf-loading">
            <LoaderCircle size={24} className="pdf-spinner" />
            <p>正在打开原 PDF…</p>
          </div>
        )}
        {pdf && (
          <div
            className="pdf-sheet"
            style={
              {
                width: pageSize.width,
                height: pageSize.height,
                '--total-scale-factor': pageSize.scale,
                '--scale-round-x': '1px',
                '--scale-round-y': '1px',
              } as CSSProperties
            }
            data-document-id={documentId}
            data-page-index={pageIndex}
          >
            <canvas
              ref={canvas}
              aria-label={`${doc.title} PDF 第 ${pageIndex + 1} 页`}
            />
            <div
              ref={layer}
              className="pdf-text-layer"
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
            />
            {rendering && (
              <div className="pdf-page-loading">
                <LoaderCircle size={22} className="pdf-spinner" />
              </div>
            )}
          </div>
        )}
      </div>
      <div className="pdf-footer">
        <span>{doc.filename}</span>
        <span>
          PDF 第 {pageIndex + 1} 页 · {Math.round(position.scale * 100)}%
        </span>
      </div>
    </section>
  );
}
