import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
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
  Scan,
  Sparkles,
  X,
} from 'lucide-react';
import { TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import type { ResourceAnchor } from '../../domain/types';
import { scopeKey, useWorkspace } from '../../services/workspace';
import { loadPdfDocument } from '../../services/pdf';
import { getAIConfig, submitAI } from '../../services/ai';
import { contentHash, putAsset } from '../../data/storage';
import { ImportPDFButton } from './ImportPDFButton';
import { cropRegion, regionFromPoints, rotateRegion, validRegion, type RegionRect } from './region';
import './reader.css';

type Outline = { title: string; pageIndex: number; depth: number };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
type SelectionAction = 'card' | 'ai' | 'explain';
type RegionPreview = { blob: Blob; url: string; width: number; height: number; rect: RegionRect; rotation: number };
const explanationPrompt = '请解释所选材料的核心观点，并说明适用条件与限制。';

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
  const [selectionMode, setSelectionMode] = useState<'text' | 'region'>('text');
  const [menuPosition, setMenuPosition] = useState({ left: 12, top: 12 });
  const [regionRect, setRegionRect] = useState<RegionRect>();
  const [regionPreview, setRegionPreview] = useState<RegionPreview>();
  const [selectionError, setSelectionError] = useState('');
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<SelectionAction>();
  const [targetResearch, setTargetResearch] = useState('');
  const [imagesSupported, setImagesSupported] = useState<boolean>();
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const selectionVersion = useRef(0);
  const [width, setWidth] = useState(target === 'main' ? 720 : 320);
  const [pageSize, setPageSize] = useState({
    width: 612,
    height: 792,
    scale: 1,
    rotation: 0,
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

  useEffect(() => () => { if (regionPreview) URL.revokeObjectURL(regionPreview.url); }, [regionPreview]);

  useEffect(() => {
    let active = true;
    if (selectionMode === 'region') getAIConfig().then((config) => {
      if (active) setImagesSupported(config.images);
    }).catch(() => { if (active) setImagesSupported(false); });
    return () => { active = false; };
  }, [selectionMode]);

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
    clearSelection();
    return () => {
      selectionVersion.current++;
      if (actions.getState().selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}`)
        actions.setSelection(undefined);
    };
  }, [documentId, target, viewScope, pageIndex, position.scale, width]);

  useEffect(() => {
    if (!pdf || !scroll.current) return;
    const update = () => setWidth(scroll.current!.clientWidth);
    const observer = new ResizeObserver(update);
    observer.observe(scroll.current);
    update();
    return () => observer.disconnect();
  }, [pdf]);

  useEffect(() => {
    if (rendering || !sourceValid || sourceEvidence.pageIndex !== pageIndex || !sourceEvidence.region) return;
    const rect = rotateRegion(sourceEvidence.region.rect, pageSize.rotation - sourceEvidence.region.rotation);
    scroll.current?.scrollTo({ top: Math.max(0, rect.y * pageSize.height - 60), left: Math.max(0, rect.x * pageSize.width - 40) });
  }, [rendering, pageIndex, anchor?.evidenceId, pageSize.height, pageSize.width, pageSize.rotation]);

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
        rotation: viewport.rotation,
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
    clearSelection();
    actions.setReader(
      documentId,
      { pageIndex: next, scale: position.scale },
      target,
    );
  }
  function clearSelection() {
    selectionVersion.current++;
    setQuote('');
    setRegionRect(undefined);
    setRegionPreview(undefined);
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
    dragStart.current = undefined;
    if (actions.getState().selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}`)
      actions.setSelection(undefined);
    const selection = window.getSelection();
    if (selection?.rangeCount && layer.current?.contains(selection.getRangeAt(0).commonAncestorContainer))
      selection.removeAllRanges();
  }
  function captureSelection() {
    if (selectionMode !== 'text') return;
    const selection = window.getSelection();
    if (!pageTextReady || !selection?.rangeCount || !layer.current) return;
    const range = selection.getRangeAt(0);
    if (
      !layer.current.contains(range.startContainer) ||
      !layer.current.contains(range.endContainer)
    ) {
      if (normalize(selection.toString()))
        setSelectionError('请在同一 PDF 页内选择文字；多页内容请逐页加入材料。');
      return;
    }
    const selected = normalize(selection.toString());
    if (!selected) {
      setQuote('');
      actions.setSelection(undefined);
      return;
    }
    if (selected.length > 8000) {
      setSelectionError('请选择较短的原文段落（最多 8000 字符）。');
      return;
    }
    selectionVersion.current++;
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
    setQuote(selected);
    const bounds = range.getBoundingClientRect();
    const pageBounds = layer.current.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(8, Math.min(bounds.left - pageBounds.left, pageBounds.width - Math.min(480, pageBounds.width - 16))),
      top: bounds.bottom - pageBounds.top + 180 > pageBounds.height
        ? Math.max(8, bounds.top - pageBounds.top - 180)
        : Math.max(8, bounds.bottom - pageBounds.top + 8),
    });
    actions.setSelection({
      scope: data.scope,
      viewInstanceId: `reader:${viewScope}:${target}:${documentId}`,
      selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }],
      textRange: { documentId, pageIndex, quote: selected },
      evidenceIds: [],
    });
  }
  function regionPoint(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }
  function startRegion(event: PointerEvent<HTMLDivElement>) {
    if (rendering || event.button !== 0) return;
    clearSelection();
    dragStart.current = regionPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveRegion(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    setRegionRect(regionFromPoints(dragStart.current, regionPoint(event)));
  }
  function finishRegion(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const rect = regionFromPoints(dragStart.current, regionPoint(event));
    dragStart.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (rect.width * pageSize.width < 8 || rect.height * pageSize.height < 8) {
      setRegionRect(undefined);
      setSelectionError('区域太小，请框选至少 8 × 8 像素，或使用下方百分比调整。');
      return;
    }
    setRegionRect(rect);
    void previewRegion(rect);
  }
  async function previewRegion(rect = regionRect) {
    if (!rect || !canvas.current || rendering || !validRegion(rect)) return;
    const version = ++selectionVersion.current;
    setSelectionBusy(true);
    setSelectionError('');
    try {
      const result = await cropRegion(canvas.current, rect);
      if (version !== selectionVersion.current) return;
      setRegionPreview({ ...result, url: URL.createObjectURL(result.blob), rect: { ...rect }, rotation: pageSize.rotation });
    } catch (error) {
      if (version === selectionVersion.current)
        setSelectionError(error instanceof Error ? error.message : '区域截图失败，请重试');
    } finally {
      if (version === selectionVersion.current) setSelectionBusy(false);
    }
  }
  function updateRegion(key: keyof RegionRect, value: number) {
    const current = regionRect ?? { x: 0.1, y: 0.1, width: 0.5, height: 0.25 };
    const updated = { ...current, [key]: Math.max(0, Math.min(1, value / 100)) };
    updated.width = Math.min(updated.width, 1 - updated.x);
    updated.height = Math.min(updated.height, 1 - updated.y);
    selectionVersion.current++;
    setRegionRect(updated);
    setRegionPreview(undefined);
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
  }
  async function saveSelection(mode: SelectionAction, researchId?: string) {
    if (selectionBusy || (selectionMode === 'text' ? !quote || !pageTextReady : !regionPreview)) return;
    if (mode !== 'card' && !research && !researchId) {
      setPendingAction(mode);
      return;
    }
    const version = selectionVersion.current;
    const originScope = data.scope;
    const selectedDocument = documentId;
    const selectedPage = pageIndex;
    const selectedQuote = quote;
    const selectedRegion = regionPreview;
    const selectedResearchId = researchId ?? research?.id;
    setSelectionBusy(true);
    setSelectionError('');
    try {
      if (selectionMode === 'region' && mode !== 'card') {
        const config = await getAIConfig();
        setImagesSupported(config.images);
        if (!config.images) throw new Error('当前模型未启用图片。所选区域已保留，可创建人工卡片或启用图像模型后重试。');
      }
      let evidenceId: string;
      const existing = Object.values(actions.getState().data.evidence).find((item) =>
        item.documentId === selectedDocument && item.pageIndex === selectedPage &&
        (selectionMode === 'region'
          ? item.kind === 'region' && !!item.region && item.region.rotation === selectedRegion?.rotation && JSON.stringify(item.region.rect) === JSON.stringify(selectedRegion?.rect)
          : item.kind !== 'region' && item.quote === selectedQuote));
      if (existing) evidenceId = existing.id;
      else if (selectionMode === 'region' && selectedRegion) {
        const hash = await contentHash(await selectedRegion.blob.arrayBuffer());
        const assetId = crypto.randomUUID();
        await putAsset(assetId, selectedRegion.blob);
        evidenceId = actions.createRegionEvidence({
          documentId: selectedDocument,
          pageIndex: selectedPage,
          quote: '',
          region: { assetId, hash, rect: selectedRegion.rect, rotation: selectedRegion.rotation, width: selectedRegion.width, height: selectedRegion.height },
        });
      } else evidenceId = actions.createEvidence({ documentId: selectedDocument, pageIndex: selectedPage, quote: selectedQuote });
      if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) {
        actions.notice('已保存所选证据；当前阅读位置已改变，请从证据列表继续。');
        return;
      }
      if (mode !== 'card') {
        if (researchId) {
          actions.associateDocument(researchId, selectedDocument);
          actions.switchResearch(researchId);
          actions.openResource({ kind: 'document', id: selectedDocument }, { scope: { kind: 'research', researchId }, target: 'main', anchor: { pageIndex: selectedPage, evidenceId } });
        }
        actions.contextFromEvidence(actions.getState().data.evidence[evidenceId]);
        setPendingAction(undefined);
        if (mode === 'explain' && selectedResearchId) {
          const conversation = actions.getActiveConversation(selectedResearchId);
          await submitAI(selectedResearchId, conversation.id, explanationPrompt);
        } else actions.notice('已加入当前对话，尚未发送；请在 AI 输入区填写问题。');
        window.setTimeout(() => document.querySelector<HTMLTextAreaElement>('.reading-ai textarea[aria-label="向 AI 提问"]')?.focus(), 0);
      } else {
        const cardId = actions.createCard([evidenceId], '新的观点', '');
        actions.openResource(
          { kind: 'card', id: cardId },
          { scope: originScope, target: 'inspector' },
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建证据失败，请重试。';
      setSelectionError(message);
      actions.notice(message);
    } finally {
      if (version === selectionVersion.current) setSelectionBusy(false);
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
  const researchPicker = pendingAction && (
    <div className="pdf-research-picker">
      <label>
        选择用于本次对话的研究
        <select aria-label="选区目标研究" value={targetResearch} onChange={(event) => setTargetResearch(event.target.value)}>
          <option value="">请选择研究</option>
          {Object.values(data.researches).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {Object.keys(data.researches).length ? (
        <button className="primary" disabled={!targetResearch || selectionBusy} onClick={() => void saveSelection(pendingAction, targetResearch)}>
          加入所选研究并用于对话
        </button>
      ) : <p>请先从左侧新建研究；当前选区会保留到离开本页。</p>}
      <button className="text-button" onClick={() => setPendingAction(undefined)}>取消</button>
    </div>
  );
  const selectionActions = (
    <>
      <div className="pdf-selection-actions">
        <button className="primary" disabled={selectionBusy || (selectionMode === 'region' && imagesSupported === false)} title={explanationPrompt} onClick={() => void saveSelection('explain')}>
          <Sparkles size={14} />解释这段
        </button>
        <button className="button" disabled={selectionBusy || (selectionMode === 'region' && imagesSupported === false)} onClick={() => void saveSelection('ai')}>向 AI 提问</button>
        <button className="text-button" disabled={selectionBusy || (selectionMode === 'region' && imagesSupported === false)} onClick={() => void saveSelection('ai')}>加入当前对话</button>
        <button className="button" disabled={selectionBusy} onClick={() => void saveSelection('card')}><Layers size={14} />创建卡片</button>
        <button className="icon-button" aria-label="取消原文选区" onClick={clearSelection}><X size={14} /></button>
      </div>
      <span className="pdf-selection-hint">快捷提问：{explanationPrompt}</span>
      {researchPicker}
    </>
  );
  const sourceRegion = sourceValid && sourceEvidence.kind === 'region' && sourceEvidence.region && sourceEvidence.pageIndex === pageIndex
    ? rotateRegion(sourceEvidence.region.rect, pageSize.rotation - sourceEvidence.region.rotation)
    : undefined;
  return (
    <section
      className={`pdf-reader pdf-reader-${target}`}
      aria-label={`PDF 阅读器 ${target === 'main' ? '主区' : '参考面板'}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && (quote || regionRect)) {
          event.stopPropagation();
          clearSelection();
        }
      }}
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
        <div className="pdf-selection-modes" role="group" aria-label="PDF 选择方式">
          <button className={selectionMode === 'text' ? 'active' : ''} aria-pressed={selectionMode === 'text'} onClick={() => { clearSelection(); setSelectionMode('text'); }}><FileText size={13} />文字选择</button>
          <button className={selectionMode === 'region' ? 'active' : ''} aria-pressed={selectionMode === 'region'} onClick={() => { clearSelection(); setSelectionMode('region'); }}><Scan size={13} />区域框选</button>
        </div>
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
          此 PDF 没有文本层。切换“区域框选”可保留图像证据，并向支持图片的模型提问。OCR 将在后续支持。
        </div>
      )}
      {sourceValid && (
        <div className="pdf-anchor-quote">
          <span>来源 · PDF 第 {sourceEvidence.pageIndex + 1} 页</span>
          <blockquote>{sourceEvidence.quote || '区域图像证据 · 原页选框已高亮'}</blockquote>
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
      {selectionError && <div className="pdf-text-notice" role="alert">{selectionError}</div>}
      {selectionMode === 'region' && (
        <div className="pdf-region-panel">
          {regionPreview ? (
            <div className="pdf-region-preview">
              <img src={regionPreview.url} alt={`所选区域预览，PDF 第 ${pageIndex + 1} 页`} />
              <div>
                <strong>PDF 第 {pageIndex + 1} 页 · 实际发送图像</strong>
                <span>{regionPreview.width} × {regionPreview.height} px · {(regionPreview.blob.size / 1024).toFixed(0)} KB</span>
                {selectionActions}
              </div>
            </div>
          ) : <p>{selectionBusy ? '正在截取所选 PDF 区域…' : '在当前页拖框选择图表、公式或扫描内容。仅截取框内图像，确认预览后再加入对话。'}</p>}
          {imagesSupported === false && <p className="pdf-region-capability">当前模型未启用图片。可继续框选并创建人工卡片；启用图像模型后重新点击“区域框选”更新状态。</p>}
          <details className="pdf-region-keyboard">
            <summary>用百分比精确框选（键盘）</summary>
            <div className="pdf-region-fields">
              {([['x', '左'], ['y', '上'], ['width', '宽'], ['height', '高']] as const).map(([key, label]) => (
                <label key={key}>{label} %<input aria-label={`区域${label}百分比`} type="number" min={0} max={100} step={1} value={Math.round((regionRect ?? { x: 0.1, y: 0.1, width: 0.5, height: 0.25 })[key] * 100)} onChange={(event) => updateRegion(key, Number(event.target.value))} /></label>
              ))}
              <button className="button" disabled={rendering || selectionBusy || (!!regionRect && !validRegion(regionRect))} onClick={() => {
                const rect = regionRect ?? { x: 0.1, y: 0.1, width: 0.5, height: 0.25 };
                setRegionRect(rect);
                void previewRegion(rect);
              }}>预览区域</button>
              <button className="text-button" onClick={clearSelection}>取消框选</button>
            </div>
          </details>
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
              className={`pdf-text-layer ${selectionMode === 'region' ? 'pdf-text-layer-inactive' : ''}`}
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
            />
            {sourceRegion && <div className="pdf-region-source" aria-label="来源区域高亮" style={{ left: `${sourceRegion.x * 100}%`, top: `${sourceRegion.y * 100}%`, width: `${sourceRegion.width * 100}%`, height: `${sourceRegion.height * 100}%` }} />}
            {selectionMode === 'region' && (
              <div className="pdf-region-layer" aria-label="拖动框选当前 PDF 页区域" onPointerDown={startRegion} onPointerMove={moveRegion} onPointerUp={finishRegion} onPointerCancel={() => { dragStart.current = undefined; }} onKeyDown={(event) => { if (event.key === 'Escape') clearSelection(); }} tabIndex={0}>
                {regionRect && <div className="pdf-region-box" style={{ left: `${regionRect.x * 100}%`, top: `${regionRect.y * 100}%`, width: `${regionRect.width * 100}%`, height: `${regionRect.height * 100}%` }} />}
              </div>
            )}
            {quote && selectionMode === 'text' && (
              <div className="pdf-selection-menu" aria-label="原文选区操作" style={menuPosition}>
                <span>PDF 第 {pageIndex + 1} 页 · {quote.length} 字符已选</span>
                <details className="pdf-selection-preview"><summary>查看所选原文</summary><blockquote>{quote}</blockquote></details>
                {selectionActions}
              </div>
            )}
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
