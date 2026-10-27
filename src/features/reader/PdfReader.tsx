import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FileText,
  Layers,
  Languages,
  MessageCircle,
  List,
  LoaderCircle,
  Minus,
  Plus,
  RotateCw,
  Search,
  Scan,
  X,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Evidence, ReadingPosition, ReaderActivity, ReaderTarget, ResourceAnchor } from '../../domain/types';
import { evidenceGroup, pageRangeLabel } from '../../domain/evidence';
import { getReaderPosition, registerReaderFlush, scopeKey, useWorkspace } from '../../services/workspace';
import { loadPdfDocument } from '../../services/pdf';
import { createInlineConversation, type InlineAISelection } from '../../services/inline-ai';
import { readerActivities, recordReaderAction } from '../../services/reader-actions';
import { PdfPage, type PageHandle, type PageSize } from './PdfPage';
import { contentHash, getAsset, putAsset } from '../../data/storage';
import { hasFullText } from '../../domain/knowledge';
import { ImportPDFButton } from './ImportPDFButton';
import { cropRegion, rotateRegion, validRegion, type RegionRect } from './region';
import { pageRegionFragments, pageTextFragments, selectionScrollStep, type SelectionPoint } from './cross-page-selection';
import { InlineAIPopover, ReaderPopover, type ReaderSelectionAnchor } from './InlineAIPopover';
import { ReaderActivityList } from './ReaderActivityList';
import { captureTextAnchor, rangeForTextAnchor, textInsideRegion, type TextAnchor } from './text-anchor';
import './reader.css';

type Outline = { title: string; pageIndex: number; depth: number };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
type SelectionAction = 'excerpt' | 'card' | 'ai' | 'explain' | 'translation' | 'summary' | 'highlight' | 'attach';
type RegionPreview = { pageIndex: number; blob: Blob; url: string; width: number; height: number; rect: RegionRect; rotation: number; quote: string };
type RegionFragment = { pageIndex: number; rect: RegionRect };
type SelectionDrag = { kind: 'text' | 'region'; pageIndex: number; endPageIndex?: number; endPoint?: SelectionPoint; start: SelectionPoint; client: SelectionPoint; anchorNode?: Node; anchorOffset?: number; anchorTextAnchor?: TextAnchor; anchorAfter?: boolean };

export function PdfReader({
  documentId,
  target = 'main',
  anchor,
}: {
  documentId: string;
  target?: ReaderTarget;
  anchor?: ResourceAnchor;
}) {
  const { data, session, research, selection, actions } = useWorkspace();
  const doc = data.documents[documentId];
  const position = getReaderPosition(session, documentId, target);
  const initialPage = Math.min(position.pageIndex, Math.max(0, (doc?.pageCount ?? 1) - 1));
  const [pageIndex, setVisiblePage] = useState(initialPage);
  const [selectionPage, setSelectionPage] = useState<number>();
  const selectedPageIndex = selectionPage ?? pageIndex;
  const pageHandles = useRef(new Map<number, PageHandle>());
  const [, refreshPages] = useState(0);
  const [naturalSizes, setNaturalSizes] = useState<PageSize[]>([]);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [textRetry, setTextRetry] = useState(0);
  const [textState, setTextState] = useState<
    'pending' | 'ready' | 'empty' | 'error'
  >('pending');
  const [pagesText, setPagesText] = useState<string[]>([]);
  const [outline, setOutline] = useState<Outline[]>([]);
  const [showNavigation, setShowNavigation] = useState(false);
  const [search, setSearch] = useState('');
  const [quote, setQuote] = useState('');
  const [textAnchor, setTextAnchor] = useState<TextAnchor>();
  const [textFragments, setTextFragments] = useState<InlineAISelection[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'text' | 'region'>('text');
  const [selectionAnchor, setSelectionAnchor] = useState<ReaderSelectionAnchor>({ left: 12, top: 12, width: 1, height: 1 });
  const [inlineConversationId, setInlineConversationId] = useState<string>();
  const [inlineInitialAction, setInlineInitialAction] = useState<'explain' | 'ask' | 'translation' | 'summary'>('ask');
  const [inlinePage, setInlinePage] = useState<number>();
  const anchorPageWidth = useRef(0);
  const [regionRect, setRegionRect] = useState<RegionRect>();
  const [regionPreview, setRegionPreview] = useState<RegionPreview>();
  const [regionFragments, setRegionFragments] = useState<RegionFragment[]>([]);
  const [regionPreviews, setRegionPreviews] = useState<RegionPreview[]>([]);
  const [dragPages, setDragPages] = useState<{ start: number; end: number }>();
  const [selectionError, setSelectionError] = useState('');
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<SelectionAction>();
  const [targetResearch, setTargetResearch] = useState('');
  const [undoExcerpt, setUndoExcerpt] = useState<string>();
  const [undoMark, setUndoMark] = useState<{ evidenceId: string; readerKey: string; generation: number }>();
  const [finishPrompt, setFinishPrompt] = useState(false);
  const dragStart = useRef<SelectionDrag | undefined>(undefined);
  const textCapturePending = useRef(false);
  const [pendingTextDrag, setPendingTextDrag] = useState<SelectionDrag>();
  const dragFrame = useRef<number | undefined>(undefined);
  const dragCallbacks = useRef<{ update: () => void; finish: () => void }>({ update() {}, finish() {} });
  const selectionVersion = useRef(0);
  const [width, setWidth] = useState(target === 'inspector' ? 320 : 720);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const layer = useRef<HTMLDivElement | null>(null);
  const pendingPosition = useRef<ReadingPosition | undefined>(undefined);
  const positionTimer = useRef<number | undefined>(undefined);
  const lastWrittenPosition = useRef<ReadingPosition | undefined>(undefined);
  const instanceGeneration = useRef(actions.getGeneration());
  const lastLayout = useRef('');
  const lastPositionKey = useRef('');
  const lastAnchorId = useRef<string | undefined>(undefined);
  const navigationRequested = useRef(false);
  const scrollFrame = useRef<number | undefined>(undefined);
  const readScroll = useRef<() => void>(() => {});
  const latestPositionFlush = useRef<{ key: string; flush: () => void } | undefined>(undefined);
  const pageSizes = useMemo(() => Array.from({ length: pdf?.numPages ?? 0 }, (_, index) => {
    const natural = naturalSizes[index] ?? naturalSizes[0] ?? { width: 612, height: 792, scale: 1, rotation: 0 };
    const fit = Math.max(0.2, Math.min(1.5, (width - (target === 'inspector' ? 24 : 56)) / natural.width));
    const scale = fit * position.scale;
    return { width: natural.width * scale, height: natural.height * scale, scale, rotation: natural.rotation };
  }), [pdf, naturalSizes, width, target, position.scale]);
  const selectedHandle = pageHandles.current.get(selectedPageIndex);
  canvas.current = selectedHandle?.canvas ?? null;
  layer.current = selectedHandle?.layer ?? null;
  const pageSize = selectedHandle?.size ?? pageSizes[selectedPageIndex] ?? { width: 612, height: 792, scale: 1, rotation: 0 };
  const rendering = !pdf || !selectedHandle || selectedHandle.rendering;
  const pageTextReady = selectedHandle?.textReady ?? false;
  const viewScope = scopeKey(data.scope);
  const readerKey = `${viewScope}:${target}:${documentId}`;
  const inlineEvidenceId = inlineConversationId && data.conversations[inlineConversationId]?.inlineSource?.evidenceId;
  const inlineEvidence = inlineEvidenceId ? data.evidence[inlineEvidenceId] : undefined;
  const sourceEvidence = anchor?.evidenceId ? data.evidence[anchor.evidenceId] : undefined;
  const sourceValid =
    !!sourceEvidence &&
    sourceEvidence.documentId === documentId &&
    sourceEvidence.pageIndex >= 0 &&
    sourceEvidence.pageIndex < (doc?.pageCount ?? 0);

  useEffect(() => () => { regionPreviews.forEach(preview => URL.revokeObjectURL(preview.url)); }, [regionPreviews]);


  useEffect(() => {
    let active = true;
    setPdf(undefined);
    setError('');
    setQuote('');
    setNaturalSizes([]);
    pageHandles.current.clear();
    setPagesText([]);
    setOutline([]);
    if (!hasFullText(doc)) return;
    loadPdfDocument(doc, retry > 0)
      .then(async ({ pdf, hash }) => {
        const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
        if (!active) return;
        setNaturalSizes([{ width: first.width, height: first.height, scale: 1, rotation: first.rotation }]);
        setVisiblePage(initialPage);
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
          setError(
            error instanceof Error ? error.message : 'PDF 加载失败，请重试。',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [documentId, doc?.assetId, doc?.assetRevision, retry]);

  const activityByEvidence = useMemo(() => Object.fromEntries(Object.values(data.evidence)
    .filter(item => item.documentId === documentId).map(item => [item.id, readerActivities(data, item.id)])), [data, documentId]);
  const documentMarks = Object.values(data.evidence).filter(item => !item.annotationHidden && item.documentId === documentId
    && (!item.contextOnly || activityByEvidence[item.id]?.length) && (!research || !item.researchId || item.researchId === research.id));
  const documentExcerpts = documentMarks.filter(item => !item.contextOnly);
  const pickedIds = selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}` ? selection.evidenceIds : [];
  const pickedExcerpt = pickedIds.map(id => data.evidence[id]).find(item => item?.pageIndex === selectedPageIndex) ?? data.evidence[pickedIds[0]];
  const selectedExcerpt = pickedExcerpt?.documentId === documentId && pickedExcerpt.pageIndex === selectedPageIndex ? pickedExcerpt : [...documentMarks, ...(sourceValid && sourceEvidence ? [sourceEvidence] : [])].find(item => item.pageIndex === selectedPageIndex && (selectionMode === 'region'
    ? item.kind === 'region' && !!item.region && !!regionPreview && JSON.stringify(rotateRegion(item.region.rect, regionPreview.rotation - item.region.rotation)) === JSON.stringify(regionPreview.rect)
    : item.kind !== 'region' && !!quote && item.quote === quote && (!textAnchor || item.textAnchor?.start === textAnchor.start && item.textAnchor?.end === textAnchor.end)));
  const findCard = session.panel.findEvidenceFor && data.cards[session.panel.findEvidenceFor];

  useEffect(() => {
    setFinishPrompt(false);
    setUndoExcerpt(undefined);
    setUndoMark(undefined);
    setInlineConversationId(undefined);
    setInlinePage(undefined);
  }, [documentId, viewScope]);

  useEffect(() => {
    if (doc?.readingStatus !== 'read' || doc.finishPromptShown || !documentExcerpts.length) return;
    setFinishPrompt(true);
    actions.updateData(next => { if (next.documents[documentId]) next.documents[documentId].finishPromptShown = true; });
  }, [doc?.readingStatus, doc?.finishPromptShown, documentExcerpts.length, documentId]);

  useEffect(() => {
    clearSelection();
    return () => {
      selectionVersion.current++;
      if (actions.getState().selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}`)
        actions.setSelection(undefined);
    };
  }, [documentId, target, viewScope]);

  useEffect(() => {
    if (!inlineConversationId || inlinePage === undefined) { clearSelection(); return; }
    const nextWidth = pageSizes[inlinePage]?.width;
    if (nextWidth && anchorPageWidth.current) {
      const ratio = nextWidth / anchorPageWidth.current;
      setSelectionAnchor(previous => ({ left: previous.left * ratio, top: previous.top * ratio, width: previous.width * ratio, height: previous.height * ratio }));
      anchorPageWidth.current = nextWidth;
    }
  }, [position.scale, width]);

  useEffect(() => {
    if (!pdf || !scroll.current) return;
    const update = () => {
      const node = scroll.current!;
      const style = getComputedStyle(node);
      const height = node.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (node.clientWidth <= 0 || height <= 0) return;
      setWidth(node.clientWidth);
      setViewportHeight(height);
    };
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
      const sizes: PageSize[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const natural = page.getViewport({ scale: 1 });
        sizes.push({ width: natural.width, height: natural.height, scale: 1, rotation: natural.rotation });
        const content = await page.getTextContent();
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
      setNaturalSizes(sizes);
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

  const layoutKey = `${documentId}:${width}:${viewportHeight}:${position.scale}:${naturalSizes.map(size => `${size.width},${size.height}`).join(';')}`;
  useEffect(() => {
    if (!pdf || !scroll.current || !pageSizes.length) return;
    const positionKey = `${position.pageIndex}:${position.scale}:${position.offset ?? 0}`;
    const ownWrite = lastWrittenPosition.current;
    const unchanged = ownWrite?.pageIndex === position.pageIndex && ownWrite?.scale === position.scale && ownWrite?.offset === position.offset;
    const externalNavigation = navigationRequested.current || (!unchanged && lastPositionKey.current !== positionKey) || lastAnchorId.current !== anchor?.evidenceId;
    navigationRequested.current = false;
    lastPositionKey.current = positionKey;
    lastAnchorId.current = anchor?.evidenceId;
    if (!externalNavigation && unchanged && lastLayout.current === layoutKey) return;
    const destination = !externalNavigation && pendingPosition.current ? pendingPosition.current : position;
    if (destination !== position) flushPosition();
    window.clearTimeout(positionTimer.current);
    pendingPosition.current = undefined;
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = undefined;
    lastLayout.current = layoutKey;
    const index = Math.min(destination.pageIndex, pdf.numPages - 1);
    setVisiblePage(index);
    const top = pageSizes.slice(0, index).reduce((sum, size) => sum + size.height + 24, 0);
    // Moving a view keeps its saved scroll position even while the source remains highlighted.
    const region = externalNavigation && !destination.offset && sourceValid && sourceEvidence.region && sourceEvidence.pageIndex === index
      ? rotateRegion(sourceEvidence.region.rect, pageSizes[index].rotation - sourceEvidence.region.rotation) : undefined;
    const offset = region ? region.y : destination.offset ?? 0;
    scroll.current.scrollTo({ top: Math.max(0, top + offset * pageSizes[index].height - (region ? 40 : 0)), left: 0 });
  }, [pdf, layoutKey, position.pageIndex, position.offset, anchor?.evidenceId, navigationRevision]);

  function flushPosition() {
    window.clearTimeout(positionTimer.current);
    const next = pendingPosition.current;
    pendingPosition.current = undefined;
    if (!next || actions.getGeneration() !== instanceGeneration.current) return;
    lastWrittenPosition.current = next;
    actions.setReader(documentId, next, target, data.scope);
  }
  latestPositionFlush.current = { key: readerKey, flush: () => {
    const positionKey = `${position.pageIndex}:${position.scale}:${position.offset ?? 0}`;
    if (!navigationRequested.current && lastPositionKey.current === positionKey) readScroll.current();
    flushPosition();
  } };
  useLayoutEffect(() => {
    const flush = () => {
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = undefined;
      const latest = latestPositionFlush.current;
      if (latest?.key === readerKey) latest.flush();
      else flushPosition();
    };
    const unregister = target.startsWith('view:') ? registerReaderFlush(`${viewScope}:${target}`, flush) : undefined;
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      // Capture the last scroll before moving this view detaches its DOM.
      flush();
      unregister?.();
    };
  }, [documentId, target, viewScope]);

  function trackScroll() {
    if (scrollFrame.current !== undefined) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = undefined;
      readScroll.current();
    });
  }
  readScroll.current = () => {
      if (!scroll.current || scroll.current.clientWidth <= 0 || scroll.current.clientHeight <= 0 || !pageSizes.length || lastLayout.current !== layoutKey) return;
      let top = 0, index = 0;
      const y = Math.max(0, scroll.current.scrollTop);
      // Browser scrollTop is rounded; PDF page geometry can have fractional pixels.
      while (index < pageSizes.length - 1 && top + pageSizes[index].height + 24 <= y + 1) {
        top += pageSizes[index].height + 24;
        index++;
      }
      if (y > 0 && scroll.current.scrollHeight - scroll.current.clientHeight - y < 2) {
        index = pageSizes.length - 1;
        top = pageSizes.slice(0, index).reduce((sum, size) => sum + size.height + 24, 0);
      }
      setVisiblePage(index);
      pendingPosition.current = { pageIndex: index, scale: position.scale, offset: Math.min(1, Math.max(0, (y - top) / pageSizes[index].height)) };
      window.clearTimeout(positionTimer.current);
      if (index !== position.pageIndex) flushPosition();
      else positionTimer.current = window.setTimeout(flushPosition, 180);
  };

  function activatePage(index: number) {
    const handle = pageHandles.current.get(index);
    if (!handle) return;
    setSelectionPage(index);
    canvas.current = handle.canvas;
    layer.current = handle.layer;
  }

  function changePage(next: number) {
    navigatePosition({ pageIndex: next, scale: position.scale, offset: 0 });
  }
  function changeScale(scale: number) {
    navigatePosition({ ...(pendingPosition.current ?? { pageIndex, scale: position.scale, offset: position.offset }), scale });
  }
  function navigatePosition(next: ReadingPosition, preserveSelection = false) {
    if (!preserveSelection) clearSelection();
    window.clearTimeout(positionTimer.current);
    pendingPosition.current = undefined;
    if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = undefined;
    navigationRequested.current = true;
    actions.setReader(documentId, next, target, data.scope);
    setNavigationRevision(value => value + 1);
  }
  function clearSelection() {
    selectionVersion.current++;
    setSelectionPage(undefined);
    setQuote('');
    setTextAnchor(undefined);
    setTextFragments([]);
    setHistoryOpen(false);
    setRegionRect(undefined);
    setRegionPreview(undefined);
    setRegionFragments([]);
    setRegionPreviews([]);
    setDragPages(undefined);
    setPendingTextDrag(undefined);
    textCapturePending.current = false;
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    dragStart.current = undefined;
    if (actions.getState().selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}`)
      actions.setSelection(undefined);
    const selection = window.getSelection();
    if (selection?.rangeCount && scroll.current?.contains(selection.getRangeAt(0).commonAncestorContainer))
      selection.removeAllRanges();
  }
  function captureSelection(index: number) {
    if (textCapturePending.current) return;
    if (selectionMode !== 'text') return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || !scroll.current) return;
    const range = selection.getRangeAt(0);
    if (!scroll.current.contains(range.startContainer) || !scroll.current.contains(range.endContainer)) return;
    const pageFor = (node: Node) => Number((node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest<HTMLElement>('.pdf-sheet')?.dataset.pageIndex);
    const start = pageFor(range.startContainer), end = pageFor(range.endContainer);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return;
    const indices = Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
    const unavailable = indices.filter(index => pageHandles.current.get(index)?.textState !== 'ready');
    if (unavailable.length) {
      setDragPages({ start, end }); setQuote(''); setTextFragments([]); setPendingAction(undefined);
      setSelectionError(`${pageRangeLabel(unavailable)}文字尚未就绪或不可提取，选区已保留，未保存缺页内容。请等待或重试文字提取。`);
      return;
    }
    const fragments = pageTextFragments(range, [...pageHandles.current].filter(([, handle]) => handle.textReady).map(([pageIndex, handle]) => ({ pageIndex, layer: handle.layer })));
    const selected = fragments.map(fragment => fragment.quote).join('\n\n');
    if (!selected) {
      setQuote('');
      setTextAnchor(undefined);
      setTextFragments([]);
      setHistoryOpen(false);
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
    setTextAnchor(fragments[0].textAnchor);
    setTextFragments(fragments.map(({ pageIndex, quote, textAnchor }) => ({ documentId, pageIndex, quote, kind: 'text', ...(textAnchor ? { textAnchor } : {}) })));
    const endpoint = selection.focusNode && [...pageHandles.current].find(([, handle]) => handle.layer.contains(selection.focusNode))?.[0];
    const anchorIndex = endpoint ?? index;
    activatePage(anchorIndex);
    setHistoryOpen(false);
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    const pageLayer = pageHandles.current.get(anchorIndex)?.layer;
    if (!pageLayer) return;
    const bounds = (fragments.find(fragment => fragment.pageIndex === anchorIndex) ?? fragments[0]).range.getBoundingClientRect();
    const pageBounds = pageLayer.getBoundingClientRect();
    anchorPageWidth.current = pageBounds.width;
    setSelectionAnchor({ left: bounds.left - pageBounds.left, top: bounds.top - pageBounds.top, width: bounds.width, height: bounds.height });
    actions.setSelection({
      scope: data.scope,
      viewInstanceId: `reader:${viewScope}:${target}:${documentId}`,
      selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }],
      textRange: { documentId, pageIndex: fragments[0].pageIndex, quote: selected },
      evidenceIds: [],
    });
  }
  function contentPoint(client: SelectionPoint) {
    const node = scroll.current!, bounds = node.getBoundingClientRect();
    return { x: client.x - bounds.left + node.scrollLeft, y: client.y - bounds.top + node.scrollTop };
  }
  function pageBoxes() {
    const node = scroll.current!, bounds = node.getBoundingClientRect();
    return [...node.querySelectorAll<HTMLElement>('.pdf-sheet')].map(sheet => {
      const box = sheet.getBoundingClientRect();
      return { pageIndex: Number(sheet.dataset.pageIndex), left: box.left - bounds.left + node.scrollLeft,
        top: box.top - bounds.top + node.scrollTop, width: box.width, height: box.height };
    });
  }
  function caretAt(client: SelectionPoint) {
    const owner = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
    const range = owner.caretRangeFromPoint?.(client.x, client.y);
    if (range?.startContainer.nodeType === Node.TEXT_NODE && [...pageHandles.current.values()].some(handle => handle.layer.contains(range.startContainer))) return range;
    const spans = [...pageHandles.current.values()].filter(handle => handle.textReady).flatMap(handle => [...handle.layer.querySelectorAll('span')]);
    const nearest = spans.filter(span => span.textContent?.trim()).map(span => ({ span, rect: span.getBoundingClientRect() })).filter(item => item.rect.width && item.rect.height)
      .sort((a, b) => {
        const distance = (rect: DOMRect) => Math.max(rect.top - client.y, 0, client.y - rect.bottom) ** 2 + Math.max(rect.left - client.x, 0, client.x - rect.right) ** 2;
        return distance(a.rect) - distance(b.rect);
      })[0];
    if (!nearest) return;
    const native = owner.caretRangeFromPoint?.(Math.max(nearest.rect.left + .5, Math.min(nearest.rect.right - .5, client.x)), Math.max(nearest.rect.top + .5, Math.min(nearest.rect.bottom - .5, client.y)));
    if (native?.startContainer.nodeType === Node.TEXT_NODE && nearest.span.contains(native.startContainer)) return native;
    const walker = document.createTreeWalker(nearest.span, NodeFilter.SHOW_TEXT), character = document.createRange();
    let text: Node | null, closest: Range | undefined, distance = Infinity;
    while ((text = walker.nextNode())) for (let offset = 0; offset < (text.textContent?.length ?? 0); offset++) {
      character.setStart(text, offset); character.setEnd(text, offset + 1);
      const rect = character.getBoundingClientRect(), delta = Math.abs(rect.left + rect.width / 2 - client.x) + Math.abs(rect.top + rect.height / 2 - client.y);
      if (delta < distance) { distance = delta; closest = character.cloneRange(); closest.collapse(client.x < rect.left + rect.width / 2); }
    }
    return closest;
  }
  function startDrag(event: PointerEvent<HTMLDivElement>, index: number, kind: 'text' | 'region') {
    if (pageHandles.current.get(index)?.rendering !== false || event.button !== 0) return;
    if (kind === 'text' && event.shiftKey && scroll.current?.contains(window.getSelection()?.anchorNode ?? null)) return;
    const client = { x: event.clientX, y: event.clientY }, caret = kind === 'text' ? caretAt(client) : undefined;
    let anchorTextAnchor: TextAnchor | undefined, anchorAfter = false;
    if (caret?.startContainer.nodeType === Node.TEXT_NODE && caret.startContainer.textContent?.length) {
      const length = caret.startContainer.textContent.length, offset = Math.min(caret.startOffset, length - 1), character = document.createRange();
      character.setStart(caret.startContainer, offset); character.setEnd(caret.startContainer, offset + 1);
      anchorTextAnchor = captureTextAnchor(pageHandles.current.get(index)!.layer, character); anchorAfter = caret.startOffset === length;
    }
    clearSelection();
    activatePage(index);
    dragStart.current = { kind, pageIndex: index, start: contentPoint(client), client,
      ...(caret ? { anchorNode: caret.startContainer, anchorOffset: caret.startOffset, anchorTextAnchor, anchorAfter } : {}) };
    setDragPages({ start: index, end: index });
    if (kind === 'region') { event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }
    const tick = () => {
      if (!dragStart.current || !scroll.current) return;
      const bounds = scroll.current.getBoundingClientRect();
      const step = selectionScrollStep(dragStart.current.client.y, bounds.top, bounds.bottom);
      if (step) scroll.current.scrollTop += step;
      dragCallbacks.current.update();
      dragFrame.current = requestAnimationFrame(tick);
    };
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = requestAnimationFrame(tick);
  }
  function currentRegionFragments() {
    const drag = dragStart.current;
    return drag && scroll.current ? pageRegionFragments(drag.start, contentPoint(drag.client), pageBoxes()) : [];
  }
  dragCallbacks.current.update = () => {
    const drag = dragStart.current, node = scroll.current;
    if (!drag || !node) return;
    const point = contentPoint(drag.client), pages = pageBoxes();
    const endpoint = pages.find(page => point.y >= page.top && point.y <= page.top + page.height)?.pageIndex
      ?? pages.reduce((nearest, page) => Math.abs(page.top + page.height / 2 - point.y) < Math.abs(nearest.top + nearest.height / 2 - point.y) ? page : nearest, pages[0])?.pageIndex ?? drag.pageIndex;
    drag.endPageIndex = endpoint;
    setDragPages(previous => previous?.start === drag.pageIndex && previous.end === endpoint ? previous : { start: drag.pageIndex, end: endpoint });
    if (drag.kind === 'region') {
      const fragments = currentRegionFragments();
      setRegionFragments(fragments);
      setRegionRect(fragments.find(fragment => fragment.pageIndex === drag.pageIndex)?.rect);
    } else if (drag.anchorNode?.isConnected && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > 3) {
      const bounds = node.getBoundingClientRect();
      const caret = caretAt({ x: Math.max(bounds.left + 2, Math.min(bounds.right - 2, drag.client.x)), y: Math.max(bounds.top + 2, Math.min(bounds.bottom - 2, drag.client.y)) });
      if (caret && node.contains(caret.startContainer)) window.getSelection()?.setBaseAndExtent(drag.anchorNode, drag.anchorOffset ?? 0, caret.startContainer, caret.startOffset);
    }
  };
  dragCallbacks.current.finish = () => {
    const drag = dragStart.current;
    if (!drag) return;
    dragCallbacks.current.update();
    const fragments = drag.kind === 'region' ? currentRegionFragments() : [];
    const end = scroll.current ? contentPoint(drag.client) : drag.start;
    dragStart.current = undefined;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    if (drag.kind === 'text') {
      if (Math.hypot(end.x - drag.start.x, end.y - drag.start.y) > 3) void completeTextDrag(drag);
      else { captureSelection(drag.pageIndex); setDragPages(undefined); }
    }
    else if (Math.abs(end.x - drag.start.x) < 8 || Math.abs(end.y - drag.start.y) < 8 || !fragments.length) {
      setRegionRect(undefined); setRegionFragments([]); setDragPages(undefined);
      setSelectionError('区域太小，请框选至少 8 × 8 像素，或使用下方百分比调整。');
    } else {
      const endpoint = contentPoint(drag.client).y >= drag.start.y ? fragments.at(-1)! : fragments[0];
      activatePage(endpoint.pageIndex);
      setRegionFragments(fragments);
      void previewRegions(fragments, endpoint.pageIndex);
    }
  };
  async function completeTextDrag(drag: SelectionDrag) {
    drag.endPoint ??= contentPoint(drag.client);
    const end = drag.endPageIndex ?? drag.pageIndex;
    const indices = Array.from({ length: Math.abs(end - drag.pageIndex) + 1 }, (_, index) => Math.min(end, drag.pageIndex) + index);
    const version = ++selectionVersion.current;
    textCapturePending.current = true; setPendingTextDrag(drag); setSelectionBusy(true); setSelectionError('');
    try {
      for (let attempt = 0; indices.some(index => !pageHandles.current.get(index) || pageHandles.current.get(index)?.textState === 'pending'); attempt++) {
        if (version !== selectionVersion.current) return;
        if (attempt > 1500) throw new Error('所选页面文字仍在加载，选区已保留，请稍后重试。');
        await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      if (version !== selectionVersion.current) return;
      const unavailable = indices.filter(index => pageHandles.current.get(index)?.textState !== 'ready');
      if (unavailable.length) throw new Error(`${pageRangeLabel(unavailable)}没有可用文字或提取失败。跨页选区已保留，可重试文字提取后完成选区，或切换区域框选。`);
      if (!scroll.current) return;
      const restored = !drag.anchorNode?.isConnected && drag.anchorTextAnchor ? rangeForTextAnchor(pageHandles.current.get(drag.pageIndex)!.layer, '', drag.anchorTextAnchor) : undefined;
      const anchorNode = drag.anchorNode?.isConnected ? drag.anchorNode : drag.anchorAfter ? restored?.endContainer : restored?.startContainer;
      const anchorOffset = drag.anchorNode?.isConnected ? drag.anchorOffset ?? 0 : drag.anchorAfter ? restored?.endOffset : restored?.startOffset;
      if (!anchorNode || anchorOffset === undefined) throw new Error('原文位置已变化，选区已保留，请重新选择。');
      const bounds = scroll.current.getBoundingClientRect();
      const caret = caretAt({ x: bounds.left + drag.endPoint.x - scroll.current.scrollLeft, y: bounds.top + drag.endPoint.y - scroll.current.scrollTop });
      if (caret) window.getSelection()?.setBaseAndExtent(anchorNode, anchorOffset, caret.startContainer, caret.startOffset);
      textCapturePending.current = false; setPendingTextDrag(undefined);
      captureSelection(end); setDragPages(undefined);
    } catch (problem) {
      if (version === selectionVersion.current) setSelectionError(problem instanceof Error ? problem.message : '跨页文字选区尚未完成。');
    } finally { if (version === selectionVersion.current) setSelectionBusy(false); }
  }
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => { if (dragStart.current) { dragStart.current.client = { x: event.clientX, y: event.clientY }; dragCallbacks.current.update(); } };
    const finish = (event: globalThis.PointerEvent) => { if (dragStart.current) { dragStart.current.client = { x: event.clientX, y: event.clientY }; dragCallbacks.current.finish(); } };
    const cancel = () => { if (dragStart.current) clearSelection(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', cancel); window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel);
      dragStart.current = undefined;
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    };
  }, [readerKey]);
  useEffect(() => {
    const copy = (event: ClipboardEvent) => {
      const selected = window.getSelection();
      if (!selected?.rangeCount || selected.isCollapsed || !scroll.current) return;
      const range = selected.getRangeAt(0);
      const textLayerFor = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)?.closest('.pdf-text-layer');
      if (![range.startContainer, range.endContainer].every(node => { const layer = textLayerFor(node); return layer && scroll.current!.contains(layer); })) return;
      const pages = [...pageHandles.current].filter(([, handle]) => range.intersectsNode(handle.layer));
      if (pages.some(([, handle]) => handle.textState === 'pending')) {
        event.preventDefault(); setSelectionError('所选页面文字仍在加载，选区已保留，完成后即可复制。'); return;
      }
      const fragments = pageTextFragments(range, pages.map(([pageIndex, handle]) => ({ pageIndex, layer: handle.layer })));
      if (event.clipboardData && fragments.length) { event.clipboardData.setData('text/plain', fragments.map(fragment => fragment.quote).join('\n\n')); event.preventDefault(); }
    };
    document.addEventListener('copy', copy);
    return () => document.removeEventListener('copy', copy);
  }, [readerKey]);
  async function previewRegion(rect = regionRect, index = selectedPageIndex) {
    if (!rect || !validRegion(rect)) return;
    setRegionFragments([{ pageIndex: index, rect }]);
    await previewRegions([{ pageIndex: index, rect }], index);
  }
  async function previewRegions(fragments: RegionFragment[], index: number) {
    const version = ++selectionVersion.current;
    setSelectionBusy(true);
    setSelectionError('');
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    try {
      for (let attempt = 0; fragments.some(fragment => !pageHandles.current.get(fragment.pageIndex) || pageHandles.current.get(fragment.pageIndex)?.rendering); attempt++) {
        if (version !== selectionVersion.current) return;
        if (attempt > 250) throw new Error('所选页面尚未渲染完成，请等待后重新框选。');
        await new Promise(resolve => window.setTimeout(resolve, 20));
      }
      const previews: RegionPreview[] = [];
      for (const fragment of fragments) {
        const handle = pageHandles.current.get(fragment.pageIndex)!;
        const result = await cropRegion(handle.canvas, fragment.rect);
        previews.push({ ...result, pageIndex: fragment.pageIndex, url: '', rect: { ...fragment.rect }, rotation: handle.size.rotation,
          quote: handle.textReady ? textInsideRegion(handle.layer, fragment.rect) : '' });
      }
      if (version !== selectionVersion.current) return;
      previews.forEach(preview => { preview.url = URL.createObjectURL(preview.blob); });
      setRegionPreviews(previews);
      const preview = previews.find(item => item.pageIndex === index) ?? previews[0];
      setRegionPreview(preview);
      const handle = pageHandles.current.get(index)!;
      anchorPageWidth.current = handle.size.width;
      setSelectionAnchor({ left: preview.rect.x * handle.size.width, top: preview.rect.y * handle.size.height, width: preview.rect.width * handle.size.width, height: preview.rect.height * handle.size.height });
    } catch (error) {
      if (version === selectionVersion.current)
        setSelectionError(error instanceof Error ? error.message : '区域截图失败，请重试');
    } finally {
      if (version === selectionVersion.current) { setSelectionBusy(false); setDragPages(undefined); }
    }
  }
  function updateRegion(key: keyof RegionRect, value: number) {
    actions.setSelection(undefined);
    const current = regionRect ?? { x: 0.1, y: 0.1, width: 0.5, height: 0.25 };
    const updated = { ...current, [key]: Math.max(0, Math.min(1, value / 100)) };
    updated.width = Math.min(updated.width, 1 - updated.x);
    updated.height = Math.min(updated.height, 1 - updated.y);
    selectionVersion.current++;
    setRegionRect(updated);
    setRegionPreview(undefined);
    setRegionFragments([{ pageIndex: selectedPageIndex, rect: updated }]);
    setRegionPreviews([]);
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
  }
  async function saveSelection(mode: SelectionAction, researchId?: string) {
    if (selectionBusy || (selectionMode === 'text' ? !quote || !pageTextReady : !regionPreview)) return;
    if (!research && !researchId) { setPendingAction(mode); return; }
    const version = selectionVersion.current;
    const originScope = data.scope;
    const selectedDocument = documentId, selectedPage = selectedPageIndex;
    const selectedRegions = regionPreviews, selectedMode = selectionMode;
    const selectedFragments = textFragments.length ? textFragments : [{ documentId, pageIndex: selectedPage, quote, kind: 'text' as const, ...(textAnchor ? { textAnchor } : {}) }];
    const selectedResearchId = researchId ?? research!.id;
    const cardIdToAttach = session.panel.findEvidenceFor;
    setSelectionBusy(true); setSelectionError('');
    try {
      if (['ai', 'explain', 'translation', 'summary'].includes(mode) && selectedMode === 'region' && selectedRegions.length > 4)
        throw new Error(`本次选中 ${selectedRegions.length} 页区域，单次最多发送 4 张图片。选区已保留，可保存摘录、制作卡片，或减少所选页数后提问。`);
      const fragments: InlineAISelection[] = selectedMode === 'text' ? selectedFragments : [];
      for (const preview of selectedMode === 'region' ? selectedRegions : []) {
        const hash = await contentHash(await preview.blob.arrayBuffer());
        const existing = Object.values(actions.getState().data.evidence).find(item => item.researchId === selectedResearchId && item.documentId === selectedDocument
          && item.pageIndex === preview.pageIndex && item.kind === 'region' && item.region?.hash === hash && item.region.rotation === preview.rotation
          && JSON.stringify(item.region.rect) === JSON.stringify(preview.rect));
        const assetId = existing?.region?.assetId ?? crypto.randomUUID(), stored = existing && await getAsset(assetId);
        if (!stored || await contentHash(await stored.arrayBuffer()) !== hash) await putAsset(assetId, preview.blob);
        fragments.push({ documentId: selectedDocument, pageIndex: preview.pageIndex, kind: 'region', quote: preview.quote,
          region: { assetId, hash, rect: preview.rect, rotation: preview.rotation, width: preview.width, height: preview.height } });
      }
      if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) return;
      if (mode === 'ai' || mode === 'explain' || mode === 'translation' || mode === 'summary') {
        const operation = mode === 'translation' || mode === 'summary' ? mode : 'question';
        const source: InlineAISelection = { ...fragments[0], ...(fragments.length > 1 ? { fragments } : {}) };
        if (mode === 'translation' && !fragments.some(fragment => fragment.quote.trim())) throw new Error('此区域没有可提取的文字，尚未进行 OCR。可以提问或生成区域摘要。');
        actions.associateDocument(selectedResearchId, selectedDocument);
        const id = createInlineConversation(selectedResearchId, source, { operation });
        expandInlineGroup(selectedResearchId);
        if (!research) actions.updateData(next => { next.sessions[scopeKey(originScope)].libraryResearchId = selectedResearchId; });
        setInlineInitialAction(mode === 'translation' || mode === 'summary' ? mode : mode === 'explain' ? 'explain' : 'ask');
        setInlinePage(selectedPage);
        setInlineConversationId(id);
        setPendingAction(undefined);
        return;
      }
      const beforeIds = new Set(Object.keys(actions.getState().data.evidence));
      const evidenceIds = actions.captureReaderSelection(selectedResearchId, fragments);
      const evidenceId = evidenceIds[0];
      if (mode === 'attach') {
        if (!cardIdToAttach) throw new Error('找依据的卡片已关闭，请重新选择。');
        evidenceIds.forEach(id => actions.attachEvidenceToCard(cardIdToAttach, id));
      }
      if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) {
        actions.notice('已保存摘录；当前阅读位置已改变，请从摘录列表继续。'); return;
      }
      if (mode === 'excerpt' || mode === 'highlight') {
        evidenceIds.forEach(id => recordReaderAction(id, mode));
        setUndoExcerpt(evidenceIds.every(id => !beforeIds.has(id)) ? evidenceId : undefined);
        actions.notice(evidenceIds.every(id => beforeIds.has(id)) ? '已摘录，已复用已有原文。' : `已摘录 · ${pageRangeLabel(fragments.map(fragment => fragment.pageIndex))}`);
      } else if (mode === 'card') {
        const cardId = actions.createCard(evidenceIds, '新的观点', '', selectedResearchId);
        evidenceIds.forEach(id => recordReaderAction(id, 'card', cardId));
        actions.openResource({ kind: 'card', id: cardId }, { scope: { kind: 'research', researchId: selectedResearchId }, target: 'inspector' });
      }
      actions.setSelection({ scope: originScope, viewInstanceId: `reader:${viewScope}:${target}:${documentId}`, selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }], evidenceIds });
      setPendingAction(undefined);
    } catch (error) {
      if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) return;
      const message = error instanceof Error ? error.message : '摘录失败，请重试。';
      setSelectionError(message); actions.notice(message);
    } finally { if (version === selectionVersion.current) setSelectionBusy(false); }
  }
  function removeExcerpt(evidenceId: string) {
    try { actions.removeExcerpt(evidenceId); setUndoExcerpt(undefined); clearSelection(); actions.notice('已取消摘录'); }
    catch (problem) { setSelectionError(problem instanceof Error ? problem.message : '取消摘录失败，请重试。'); }
  }
  function changeMark(evidenceId: string, marked: boolean, closeSelection = false) {
    try {
      actions.setExcerptMarked(evidenceId, marked);
      setUndoExcerpt(undefined);
      if (marked) setUndoMark(previous => previous?.evidenceId === evidenceId ? undefined : previous);
      else setUndoMark({ evidenceId, readerKey, generation: actions.getGeneration() });
      if (closeSelection) clearSelection();
      actions.notice(marked ? '已恢复原文标记。' : '已移除原文标记，提问、摘录与卡片已保留。');
    } catch (problem) { setSelectionError(problem instanceof Error ? problem.message : '标记操作失败，请重试。'); }
  }
  function openHighlightedExcerpt(element: HTMLElement, index: number) {
    if (normalize(window.getSelection()?.toString() ?? '')) return;
    const id = element.closest<HTMLElement>('[data-evidence-id]')?.dataset.evidenceId;
    const item = id && data.evidence[id];
    if (!item || item.kind === 'region') return;
    const group = evidenceGroup(data, item);
    clearSelection();
    activatePage(index);
    selectionVersion.current++; setQuote(group.map(fragment => fragment.quote).join('\n\n')); setTextAnchor(item.textAnchor);
    setTextFragments(group.map(fragment => ({ documentId, pageIndex: fragment.pageIndex, quote: fragment.quote, kind: 'text', ...(fragment.textAnchor ? { textAnchor: fragment.textAnchor } : {}) })));
    setHistoryOpen(true); setSelectionMode('text'); setSelectionError(''); setInlineConversationId(undefined); setInlinePage(undefined);
    actions.setSelection({ scope: data.scope, viewInstanceId: `reader:${viewScope}:${target}:${documentId}`, selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }], textRange: { documentId, pageIndex: index, quote: item.quote }, evidenceIds: [item.id, ...group.filter(fragment => fragment.id !== item.id).map(fragment => fragment.id)] });
    const pageLayer = pageHandles.current.get(index)?.layer;
    if (!pageLayer) return;
    const bounds = rangeForTextAnchor(pageLayer, item.quote, item.textAnchor)?.getBoundingClientRect() ?? element.getBoundingClientRect(), pageBounds = pageLayer.getBoundingClientRect();
    anchorPageWidth.current = pageBounds.width;
    setSelectionAnchor({ left: bounds.left - pageBounds.left, top: bounds.top - pageBounds.top, width: bounds.width, height: bounds.height });
  }
  async function openRegionExcerpt(item: Evidence, index: number) {
    if (!item.region) return;
    clearSelection(); activatePage(index); setSelectionMode('region'); setHistoryOpen(true);
    const version = ++selectionVersion.current, group = evidenceGroup(data, item);
    const fragments = group.map(fragment => ({ pageIndex: fragment.pageIndex, rect: rotateRegion(fragment.region!.rect, (pageSizes[fragment.pageIndex]?.rotation ?? 0) - fragment.region!.rotation) }));
    setRegionFragments(fragments); setRegionRect(fragments.find(fragment => fragment.pageIndex === index)?.rect);
    actions.setSelection({ scope: data.scope, viewInstanceId: `reader:${viewScope}:${target}:${documentId}`, selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }], evidenceIds: [item.id, ...group.filter(fragment => fragment.id !== item.id).map(fragment => fragment.id)] });
    setSelectionBusy(true);
    try {
      const previews: RegionPreview[] = [];
      for (const fragment of group) {
        const region = fragment.region!, blob = await getAsset(region.assetId);
        if (!blob || await contentHash(await blob.arrayBuffer()) !== region.hash) throw new Error('区域图片缺失或已变化，请重新框选。');
        previews.push({ pageIndex: fragment.pageIndex, blob, url: '', width: region.width, height: region.height, rect: region.rect, rotation: region.rotation, quote: fragment.quote });
      }
      if (version !== selectionVersion.current) return;
      previews.forEach(preview => { preview.url = URL.createObjectURL(preview.blob); });
      setRegionPreviews(previews); setRegionPreview(previews.find(preview => preview.pageIndex === index) ?? previews[0]);
      const rect = fragments.find(fragment => fragment.pageIndex === index)!.rect, size = pageSizes[index];
      anchorPageWidth.current = size.width;
      setSelectionAnchor({ left: rect.x * size.width, top: rect.y * size.height, width: rect.width * size.width, height: rect.height * size.height });
    } catch (problem) {
      if (version === selectionVersion.current) setSelectionError(problem instanceof Error ? problem.message : '区域图片读取失败，请重试。');
    } finally { if (version === selectionVersion.current) setSelectionBusy(false); }
  }
  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]')) return;
      if (actions.getState().selection?.viewInstanceId !== `reader:${viewScope}:${target}:${documentId}`) return;
      if (event.key === 'Escape') { event.preventDefault(); if (inlineConversationId) closeInline(); else clearSelection(); }
      else if (quote && ['h', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); void saveSelection(event.key.toLowerCase() === 'h' ? 'excerpt' : 'card'); }
    }
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [quote, regionPreview, selectionBusy, documentId, pageIndex, viewScope, selectedExcerpt?.id, session.panel.findEvidenceFor, inlineConversationId]);
  const inlineResearchId = research?.id ?? session.libraryResearchId;
  const lastInline = inlineResearchId ? Object.values(data.conversations).filter(item => item.researchId === inlineResearchId && item.inlineSource?.documentId === documentId && !item.archived && !item.deletedAt).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))[0] : undefined;
  function closeInline() {
    setInlineConversationId(undefined);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLButtonElement>(`[data-inline-trigger="${target}:${inlineInitialAction}"]`);
      (trigger ?? scroll.current)?.focus();
    }));
  }
  function reopenInline() {
    if (!lastInline?.inlineSource) return;
    clearSelection();
    const index = lastInline.inlineSource.pageIndex;
    changePage(index);
    anchorPageWidth.current = pageSizes[index]?.width ?? 0;
    setSelectionAnchor({ left: 20, top: 36, width: 1, height: 1 });
    setInlinePage(index); setInlineInitialAction('ask'); setInlineConversationId(lastInline.id);
    expandInlineGroup(lastInline.researchId);
  }
  function expandInlineGroup(researchId: string) {
    actions.updateData(next => { const session = next.sessions[researchId]; if (session) { session.discussionGroups ??= {}; session.discussionGroups[`document:${documentId}`] = true; } });
  }
  function inlineSource(evidenceId: string) {
    const item = actions.getState().data.evidence[evidenceId];
    if (!item || item.documentId !== documentId) return;
    actions.openResource({ kind: 'document', id: documentId }, {
      scope: data.scope, target: target === 'inspector' ? 'inspector' : 'main',
      ...(target.startsWith('view:') ? { viewId: target.slice(5) } : {}),
      anchor: { evidenceId, pageIndex: item.pageIndex },
    });
    const handle = pageHandles.current.get(item.pageIndex), size = pageSizes[item.pageIndex];
    const bounds = handle && rangeForTextAnchor(handle.layer, item.quote, item.textAnchor)?.getBoundingClientRect();
    const rect = item.region && rotateRegion(item.region.rect, (size?.rotation ?? 0) - item.region.rotation);
    const top = rect ? rect.y * (size?.height ?? 1) : bounds && handle ? bounds.top - handle.layer.getBoundingClientRect().top : 0;
    setInlinePage(item.pageIndex);
    anchorPageWidth.current = size?.width ?? 0;
    setSelectionAnchor({ left: rect ? rect.x * (size?.width ?? 1) : 20, top, width: rect ? rect.width * (size?.width ?? 1) : bounds?.width ?? 1, height: rect ? rect.height * (size?.height ?? 1) : bounds?.height ?? 1 });
    navigatePosition({ pageIndex: item.pageIndex, scale: position.scale, offset: Math.max(0, (top - 50) / (size?.height ?? 1)) }, true);
  }
  function openReaderActivity(activity: ReaderActivity) {
    const conversationId = activity.conversationId ?? (activity.draftId && data.cardDrafts[activity.draftId]?.conversationId);
    const conversation = conversationId ? data.conversations[conversationId] : undefined;
    if (conversation?.inlineSource) {
      setInlinePage(selectedPageIndex);
      setInlineInitialAction(conversation.inlineSource.operation === 'translation' || conversation.inlineSource.operation === 'summary' ? conversation.inlineSource.operation : 'ask');
      setInlineConversationId(conversation.id);
      expandInlineGroup(conversation.researchId);
    } else if (activity.cardId && data.cards[activity.cardId]) {
      actions.openResource({ kind: 'card', id: activity.cardId }, { scope: data.scope, target: 'inspector' });
    }
  }
  function inspectPage(index: number) {
    navigatePosition({ pageIndex: index, scale: position.scale, offset: 0 }, true);
    setSelectionPage(index);
    const handle = pageHandles.current.get(index);
    if (!handle) return;
    const fragment = textFragments.find(item => item.pageIndex === index);
    const rect = regionFragments.find(item => item.pageIndex === index)?.rect;
    const bounds = fragment && rangeForTextAnchor(handle.layer, fragment.quote, fragment.textAnchor)?.getBoundingClientRect();
    const pageBounds = handle.layer.getBoundingClientRect();
    anchorPageWidth.current = handle.size.width;
    setSelectionAnchor(rect ? { left: rect.x * handle.size.width, top: rect.y * handle.size.height, width: rect.width * handle.size.width, height: rect.height * handle.size.height }
      : bounds ? { left: bounds.left - pageBounds.left, top: bounds.top - pageBounds.top, width: bounds.width, height: bounds.height } : { left: 20, top: 36, width: 1, height: 1 });
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
  if (!hasFullText(doc)) return <div className="empty-state"><BookOpen size={28} /><h3>这篇资料还没有全文</h3><p>请在资料详情中添加 PDF 后开始阅读和摘录。</p></div>;
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
        选择目标研究
        <select aria-label="选区目标研究" value={targetResearch} onChange={(event) => setTargetResearch(event.target.value)}>
          <option value="">请选择研究</option>
          {Object.values(data.researches).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
      {Object.keys(data.researches).length ? (
        <button className="primary" disabled={!targetResearch || selectionBusy} onClick={() => void saveSelection(pendingAction, targetResearch)}>
          加入所选研究并继续
        </button>
      ) : <p>请先新建研究；当前选区会保留到离开本页。</p>}
      <button className="text-button" onClick={() => setPendingAction(undefined)}>取消</button>
    </div>
  );
  const chosenPageIndices = selectionMode === 'text' ? textFragments.map(item => item.pageIndex) : regionFragments.map(item => item.pageIndex);
  const selectedPagesLabel = pageRangeLabel(chosenPageIndices.length ? chosenPageIndices : [selectedPageIndex]);
  const regionQuote = regionPreviews.map(item => item.quote).join('\n\n').trim();
  const selectionActions = (
    <>
      <div className="pdf-selection-actions">
        <button className="text-button pdf-selection-primary" data-inline-trigger={`${target}:ask`} disabled={selectionBusy} onClick={() => void saveSelection('ai')}><MessageCircle size={14} />提问</button>
        <button className="text-button" data-inline-trigger={`${target}:translation`} disabled={selectionBusy || !(selectionMode === 'text' ? quote : regionQuote)} title={selectionMode === 'region' && !regionQuote ? '此区域没有可提取文字，尚未进行 OCR' : '翻译所选原文'} onClick={() => void saveSelection('translation')}><Languages size={14} />翻译</button>
        <button className="text-button" data-inline-trigger={`${target}:summary`} disabled={selectionBusy} onClick={() => void saveSelection('summary')}><Layers size={14} />摘要卡片</button>
        <details className="pdf-selection-more"><summary aria-label="更多操作">•••</summary><div>
          {findCard && <button className="text-button" disabled={selectionBusy} onClick={() => void saveSelection('attach')}>作为「{findCard.title}」的依据</button>}
          <button className="text-button" aria-label="摘录" disabled={selectionBusy} onClick={() => void saveSelection('excerpt')}>{selectedExcerpt && !selectedExcerpt.contextOnly ? '已存摘录' : '保存摘录'} <kbd>H</kbd></button>
          <button className="text-button" aria-label="写成卡片" disabled={selectionBusy} onClick={() => void saveSelection('card')}>制作卡片 <kbd>C</kbd></button>
          <button className="text-button" disabled={selectionBusy} onClick={() => void saveSelection('highlight')}>高亮</button>
          <button className="text-button" data-inline-trigger={`${target}:explain`} disabled={selectionBusy} onClick={() => void saveSelection('explain')}>解释这段</button>
        </div></details>
        <button className="icon-button" aria-label="取消原文选区" onClick={clearSelection}><X size={14} /></button>
      </div>
      {selectionMode === 'region' && !regionQuote && <span className="pdf-selection-hint">未提取到区域文字 · 提问和摘要需要图片理解</span>}
      {chosenPageIndices.length > 1 && <div className="pdf-selection-pages" aria-label="逐页查看选区">{chosenPageIndices.map(index => <button key={index} className="text-button" aria-pressed={selectedPageIndex === index} onClick={() => inspectPage(index)}>第 {index + 1} 页</button>)}</div>}
      {selectedExcerpt && <>
        <div className="pdf-mark-controls">
          {(activityByEvidence[selectedExcerpt.id]?.length ?? 0) > 0 && <button className="reader-activity-toggle text-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>此处记录 <span>{activityByEvidence[selectedExcerpt.id].length}</span></button>}
          <button className="text-button pdf-mark-toggle" disabled={selectionBusy} title="仅改变原文标记，保留提问、摘录、卡片与引用" onClick={() => changeMark(selectedExcerpt.id, !!selectedExcerpt.annotationHidden, !selectedExcerpt.annotationHidden)}>{selectedExcerpt.annotationHidden ? '恢复标记' : '移除标记'}</button>
        </div>
        {historyOpen && !!activityByEvidence[selectedExcerpt.id]?.length && <ReaderActivityList activities={activityByEvidence[selectedExcerpt.id]} onOpen={openReaderActivity} />}
      </>}
      {researchPicker}
    </>
  );
  return (
    <section
      className={`pdf-reader pdf-reader-pane pdf-reader-${target.startsWith('view:') ? 'workspace' : target}`}
      aria-label={target.startsWith('view:') ? 'PDF 阅读器' : `PDF 阅读器 ${target === 'main' ? '主区' : target === 'main-secondary' ? '对照位置' : '参考面板'}`}
      data-view-id={target}
      onKeyDown={(event) => {
        const editing = (event.target as HTMLElement).closest('input, textarea, select, [contenteditable=true]');
        if (!editing && !event.metaKey && !event.ctrlKey && !event.altKey && (quote || regionPreview) && ['h', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); event.stopPropagation(); void saveSelection(event.key.toLowerCase() === 'h' ? 'excerpt' : 'card'); }
        if (event.key === 'Escape' && (quote || regionRect || inlineConversationId || pendingTextDrag)) {
          event.stopPropagation();
          if (inlineConversationId) closeInline(); else clearSelection();
        }
      }}
    >
      <div className="pdf-toolbar">
        {lastInline && <button className="text-button pdf-last-inline" onClick={reopenInline} title={research ? '找回这篇论文上次的就地问答' : `找回「${data.researches[lastInline.researchId]?.title ?? '所选研究'}」中这篇论文的上次就地问答`}>上次提问</button>}
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
            onClick={() => changeScale(position.scale - 0.25)}
          >
            <Minus size={14} />
          </button>
          <button
            className="text-button"
            title="恢复适合宽度"
            onClick={() => changeScale(1)}
          >
            {Math.round(position.scale * 100)}%
          </button>
          <button
            className="icon-button"
            aria-label="放大 PDF"
            disabled={position.scale >= 2}
            onClick={() => changeScale(position.scale + 0.25)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="pdf-reading-status" role="group" aria-label="阅读状态"><button className={`text-button ${doc.readingStatus === 'skimmed' ? 'active' : ''}`} aria-pressed={doc.readingStatus === 'skimmed'} onClick={() => actions.updateData(next => { next.documents[documentId].readingStatus = 'skimmed'; next.documents[documentId].updatedAt = new Date().toISOString(); })}>略读过</button><button className={`text-button ${doc.readingStatus === 'read' ? 'active' : ''}`} aria-pressed={doc.readingStatus === 'read'} onClick={() => actions.updateData(next => { next.documents[documentId].readingStatus = 'read'; next.documents[documentId].updatedAt = new Date().toISOString(); })}>读完</button></div>
      </div>
      {finishPrompt && <div className="pdf-finish-prompt" role="status"><span>要不要用一两句话记下：这篇对你的问题有什么用？</span><button className="button" onClick={() => { const used = new Set((research?.cardIds ?? []).flatMap(id => data.cards[id]?.evidenceIds ?? [])); const id = actions.createCard(documentExcerpts.filter(item => !used.has(item.id)).map(item => item.id), `${doc.title} · 要点`, ''); actions.openResource({ kind: 'card', id }, { scope: data.scope, target: 'inspector' }); setFinishPrompt(false); }}>写一张要点卡片</button><button className="text-button" onClick={() => setFinishPrompt(false)}>不用</button></div>}
      {undoExcerpt && data.evidence[undoExcerpt] && <div className="pdf-excerpt-notice" role="status">已摘录 <button className="text-button" onClick={() => removeExcerpt(undoExcerpt)}>撤销</button></div>}
      {undoMark?.readerKey === readerKey && undoMark.generation === actions.getGeneration() && data.evidence[undoMark.evidenceId]?.annotationHidden && <div className="pdf-mark-notice" role="status">
        <span>已移除原文标记，内容与引用保留</span><button className="text-button" onClick={() => changeMark(undoMark.evidenceId, true)}>撤销移除</button>
        <button className="icon-button" aria-label="关闭标记撤销提示" onClick={() => setUndoMark(undefined)}><X size={13} /></button>
      </div>}
      <div className={`pdf-status ${pdf && !rendering && textState !== 'pending' ? 'pdf-status-ready' : ''}`}>
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
          <span>来源 · {pageRangeLabel(evidenceGroup(data, sourceEvidence).map(item => item.pageIndex))}</span>
          {evidenceGroup(data, sourceEvidence).length > 1 && <div className="pdf-selection-pages" aria-label="逐页回查来源">{evidenceGroup(data, sourceEvidence).map(item => <button key={item.id} className="text-button" aria-pressed={sourceEvidence.id === item.id} onClick={() => actions.openResource({ kind: 'document', id: documentId }, { scope: data.scope, target: target === 'inspector' ? 'inspector' : 'main', ...(target.startsWith('view:') ? { viewId: target.slice(5) } : {}), anchor: { pageIndex: item.pageIndex, evidenceId: item.id } })}>第 {item.pageIndex + 1} 页</button>)}</div>}
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
      {pendingTextDrag && <div className="pdf-text-notice" role="status">{selectionBusy ? '正在等待所有选中页的文字，跨页选区已保留…' : <button className="text-button" onClick={() => {
        setSelectionBusy(true); setTextRetry(value => value + 1);
        window.setTimeout(() => void completeTextDrag(pendingTextDrag), 0);
      }}>重试文字提取并完成选区</button>}<button className="text-button" onClick={clearSelection}>取消选区</button></div>}
      {selectionMode === 'region' && !regionPreview && (
        <div className="pdf-region-panel">
          <p>{selectionBusy ? '正在逐页截取所选 PDF 区域…' : '拖框选择图表或公式，可跨页拖动；靠近阅读区边缘会自动滚动。'}</p>
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
      <div className="pdf-scroll" ref={scroll} onScroll={trackScroll} onPointerDownCapture={event => {
        const textLayer = (event.target as HTMLElement).closest<HTMLElement>('.pdf-text-layer');
        if (selectionMode === 'text' && textLayer) startDrag(event, Number(textLayer.closest<HTMLElement>('.pdf-sheet')!.dataset.pageIndex), 'text');
      }} tabIndex={0} aria-label="连续滚动阅读区域">
        {!pdf && <div className="pdf-loading"><LoaderCircle size={24} className="pdf-spinner" /><p>正在打开原 PDF…</p></div>}
        {pdf && <div className="pdf-page-stack" style={{ paddingBottom: Math.max(0, viewportHeight - (pageSizes.at(-1)?.height ?? 0)) }}>
          {pageSizes.map((size, index) => {
            const source = inlineEvidence?.pageIndex === index && !inlineEvidence.annotationHidden ? inlineEvidence : sourceValid && sourceEvidence.pageIndex === index ? sourceEvidence : undefined;
            const sourceRegion = source?.kind === 'region' && source.region ? rotateRegion(source.region.rect, size.rotation - source.region.rotation) : undefined;
            return <PdfPage key={index} pdf={pdf} documentId={documentId} title={doc.title} pageIndex={index} size={size}
              active={Math.abs(index - pageIndex) <= 2 || textFragments.some(fragment => fragment.pageIndex === index) || regionFragments.some(fragment => fragment.pageIndex === index) || !!dragPages && index >= Math.min(dragPages.start, dragPages.end) && index <= Math.max(dragPages.start, dragPages.end)}
              selectionMode={selectionMode} excerpts={documentMarks.filter(item => item.pageIndex === index)} source={source}
              activityCounts={Object.fromEntries(Object.entries(activityByEvidence).map(([id, items]) => [id, items.length]))} retry={textRetry}
              onUpdate={handle => { if (handle) pageHandles.current.set(index, handle); else pageHandles.current.delete(index); refreshPages(value => value + 1); }}
              onTextError={() => { setTextState('error'); actions.updateData(next => { if (next.documents[documentId]) next.documents[documentId].textStatus = 'error'; }); }}
              onError={message => setError(message)}
              onSelect={() => captureSelection(index)} onExcerptClick={element => openHighlightedExcerpt(element, index)}>
              {documentMarks.filter(item => item.pageIndex === index && item.kind === 'region' && item.region).map(item => {
                const rect = rotateRegion(item.region!.rect, size.rotation - item.region!.rotation);
                return <div key={item.id} className={`pdf-saved-region ${item.contextOnly ? 'pdf-activity-region' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
                  <button className="pdf-region-activity-marker" aria-label={`查看此处记录 · ${activityByEvidence[item.id]?.length || 1}条`} onClick={() => void openRegionExcerpt(item, index)}>{activityByEvidence[item.id]?.length || 1}</button>
                </div>;
              })}
              {sourceRegion && <div className="pdf-region-source" aria-label="来源区域高亮" style={{ left: `${sourceRegion.x * 100}%`, top: `${sourceRegion.y * 100}%`, width: `${sourceRegion.width * 100}%`, height: `${sourceRegion.height * 100}%` }} />}
              {selectionMode === 'region' && <div className="pdf-region-layer" aria-label={index === pageIndex ? '拖动框选当前 PDF 页区域' : `拖动框选 PDF 第 ${index + 1} 页区域`} onPointerDown={event => startDrag(event, index, 'region')} onKeyDown={event => { if (event.key === 'Escape') clearSelection(); }} tabIndex={0}>
                {(regionFragments.length ? regionFragments.filter(fragment => fragment.pageIndex === index) : selectedPageIndex === index && regionRect ? [{ pageIndex: index, rect: regionRect }] : []).map(({ rect }) => <div key={index} className="pdf-region-box" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}
              </div>}

            </PdfPage>;
          })}
        </div>}
      </div>
      {inlineConversationId && inlinePage !== undefined && <ReaderPopover key={`inline:${inlineConversationId}`} anchor={selectionAnchor} pageElement={pageHandles.current.get(inlinePage)?.layer} boundary={scroll.current} className="inline-ai">
        <InlineAIPopover conversationId={inlineConversationId} initialAction={inlineInitialAction} onClose={closeInline} onSource={inlineSource} onMarkChange={changeMark} />
      </ReaderPopover>}
      {!inlineConversationId && (quote && selectionMode === 'text' || regionPreview && selectionMode === 'region') && <ReaderPopover anchor={selectionAnchor} pageElement={pageHandles.current.get(selectedPageIndex)?.layer} boundary={scroll.current} className="pdf-selection-menu" label="原文选区操作">
        <div className="pdf-selection-meta"><span>{selectedPagesLabel}{quote ? ` · ${quote.length} 字符` : ` · ${regionPreviews.length} 个区域`}</span>
          <details className="pdf-selection-preview"><summary>查看所选{quote ? '原文' : '区域'}</summary>{quote ? <blockquote>{quote}</blockquote> : regionPreviews.map(preview => <figure key={preview.pageIndex}><figcaption>PDF 第 {preview.pageIndex + 1} 页</figcaption><img className="pdf-inline-region-preview" src={preview.url} alt={`所选区域预览，PDF 第 ${preview.pageIndex + 1} 页`} /></figure>)}</details>
        </div>
        {selectionActions}
      </ReaderPopover>}
      <div className="pdf-footer">
        <span>{doc.filename}</span>
        <span>
          PDF 第 {pageIndex + 1} 页 · {Math.round(position.scale * 100)}%
        </span>
      </div>
    </section>
  );
}
