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
import type { ReadingPosition, ReaderActivity, ReaderTarget, ResourceAnchor } from '../../domain/types';
import { getReaderPosition, registerReaderFlush, scopeKey, useWorkspace } from '../../services/workspace';
import { loadPdfDocument } from '../../services/pdf';
import { createInlineConversation, type InlineAISelection } from '../../services/inline-ai';
import { readerActivities, recordReaderAction } from '../../services/reader-actions';
import { PdfPage, type PageHandle, type PageSize } from './PdfPage';
import { contentHash, putAsset } from '../../data/storage';
import { hasFullText } from '../../domain/knowledge';
import { ImportPDFButton } from './ImportPDFButton';
import { cropRegion, regionFromPoints, rotateRegion, validRegion, type RegionRect } from './region';
import { InlineAIPopover, ReaderPopover, type ReaderSelectionAnchor } from './InlineAIPopover';
import { ReaderActivityList } from './ReaderActivityList';
import { captureTextAnchor, rangeForTextAnchor, textInsideRegion, type TextAnchor } from './text-anchor';
import './reader.css';

type Outline = { title: string; pageIndex: number; depth: number };
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
type SelectionAction = 'excerpt' | 'card' | 'ai' | 'explain' | 'translation' | 'summary' | 'highlight' | 'attach';
type RegionPreview = { blob: Blob; url: string; width: number; height: number; rect: RegionRect; rotation: number; quote: string };

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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState<'text' | 'region'>('text');
  const [selectionAnchor, setSelectionAnchor] = useState<ReaderSelectionAnchor>({ left: 12, top: 12, width: 1, height: 1 });
  const [inlineConversationId, setInlineConversationId] = useState<string>();
  const [inlineInitialAction, setInlineInitialAction] = useState<'explain' | 'ask' | 'translation' | 'summary'>('ask');
  const [inlinePage, setInlinePage] = useState<number>();
  const anchorPageWidth = useRef(0);
  const [regionRect, setRegionRect] = useState<RegionRect>();
  const [regionPreview, setRegionPreview] = useState<RegionPreview>();
  const [selectionError, setSelectionError] = useState('');
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<SelectionAction>();
  const [targetResearch, setTargetResearch] = useState('');
  const [undoExcerpt, setUndoExcerpt] = useState<string>();
  const [finishPrompt, setFinishPrompt] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | undefined>(undefined);
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

  useEffect(() => () => { if (regionPreview) URL.revokeObjectURL(regionPreview.url); }, [regionPreview]);


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
  const pickedId = selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}` ? selection.evidenceIds[0] : undefined;
  const pickedExcerpt = pickedId ? data.evidence[pickedId] : undefined;
  const selectedExcerpt = pickedExcerpt?.documentId === documentId && pickedExcerpt.pageIndex === selectedPageIndex ? pickedExcerpt : [...documentMarks, ...(sourceValid && sourceEvidence ? [sourceEvidence] : [])].find(item => item.pageIndex === selectedPageIndex && (selectionMode === 'region'
    ? item.kind === 'region' && !!item.region && !!regionPreview && JSON.stringify(rotateRegion(item.region.rect, regionPreview.rotation - item.region.rotation)) === JSON.stringify(regionPreview.rect)
    : item.kind !== 'region' && !!quote && item.quote === quote && (!textAnchor || item.textAnchor?.start === textAnchor.start && item.textAnchor?.end === textAnchor.end)));
  const findCard = session.panel.findEvidenceFor && data.cards[session.panel.findEvidenceFor];

  useEffect(() => {
    setFinishPrompt(false);
    setUndoExcerpt(undefined);
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
    setHistoryOpen(false);
    setRegionRect(undefined);
    setRegionPreview(undefined);
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    dragStart.current = undefined;
    if (actions.getState().selection?.viewInstanceId === `reader:${viewScope}:${target}:${documentId}`)
      actions.setSelection(undefined);
    const selection = window.getSelection();
    if (selection?.rangeCount && layer.current?.contains(selection.getRangeAt(0).commonAncestorContainer))
      selection.removeAllRanges();
  }
  function captureSelection(index: number) {
    const handle = pageHandles.current.get(index);
    const pageLayer = handle?.layer;
    if (selectionMode !== 'text') return;
    const selection = window.getSelection();
    if (!handle?.textReady || !selection?.rangeCount || !pageLayer) return;
    const range = selection.getRangeAt(0);
    if (
      !pageLayer.contains(range.startContainer) ||
      !pageLayer.contains(range.endContainer)
    ) {
      if (normalize(selection.toString()))
        setSelectionError('请在同一 PDF 页内选择文字；多页内容请逐页加入材料。');
      return;
    }
    activatePage(index);
    const selected = normalize(selection.toString());
    if (!selected) {
      setQuote('');
      setTextAnchor(undefined);
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
    setTextAnchor(captureTextAnchor(pageLayer, range));
    setHistoryOpen(false);
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    const bounds = range.getBoundingClientRect();
    const pageBounds = pageLayer.getBoundingClientRect();
    anchorPageWidth.current = pageBounds.width;
    setSelectionAnchor({ left: bounds.left - pageBounds.left, top: bounds.top - pageBounds.top, width: bounds.width, height: bounds.height });
    actions.setSelection({
      scope: data.scope,
      viewInstanceId: `reader:${viewScope}:${target}:${documentId}`,
      selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }],
      textRange: { documentId, pageIndex: index, quote: selected },
      evidenceIds: [],
    });
  }
  function regionPoint(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) / bounds.width, y: (event.clientY - bounds.top) / bounds.height };
  }
  function startRegion(event: PointerEvent<HTMLDivElement>, index: number) {
    if (pageHandles.current.get(index)?.rendering !== false || event.button !== 0) return;
    clearSelection();
    activatePage(index);
    dragStart.current = regionPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
  function moveRegion(event: PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    setRegionRect(regionFromPoints(dragStart.current, regionPoint(event)));
  }
  function finishRegion(event: PointerEvent<HTMLDivElement>, index: number) {
    if (!dragStart.current) return;
    const rect = regionFromPoints(dragStart.current, regionPoint(event));
    dragStart.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const size = pageHandles.current.get(index)?.size ?? pageSize;
    if (rect.width * size.width < 8 || rect.height * size.height < 8) {
      setRegionRect(undefined);
      setSelectionError('区域太小，请框选至少 8 × 8 像素，或使用下方百分比调整。');
      return;
    }
    setRegionRect(rect);
    setSelectionAnchor({ left: rect.x * size.width, top: rect.y * size.height, width: rect.width * size.width, height: rect.height * size.height });
    void previewRegion(rect, index);
  }
  async function previewRegion(rect = regionRect, index = selectedPageIndex) {
    const handle = pageHandles.current.get(index);
    if (!rect || !handle?.canvas || handle.rendering || !validRegion(rect)) return;
    activatePage(index);
    const version = ++selectionVersion.current;
    setSelectionBusy(true);
    setSelectionError('');
    setInlineConversationId(undefined);
    setInlinePage(undefined);
    anchorPageWidth.current = handle.size.width;
    setSelectionAnchor({ left: rect.x * handle.size.width, top: rect.y * handle.size.height, width: rect.width * handle.size.width, height: rect.height * handle.size.height });
    try {
      const result = await cropRegion(handle.canvas, rect);
      if (version !== selectionVersion.current) return;
      setRegionPreview({ ...result, url: URL.createObjectURL(result.blob), rect: { ...rect }, rotation: handle.size.rotation,
        quote: handle.textReady ? textInsideRegion(handle.layer, rect) : '' });
    } catch (error) {
      if (version === selectionVersion.current)
        setSelectionError(error instanceof Error ? error.message : '区域截图失败，请重试');
    } finally {
      if (version === selectionVersion.current) setSelectionBusy(false);
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
    setSelectionBusy(false);
    setSelectionError('');
    setPendingAction(undefined);
  }
  async function saveSelection(mode: SelectionAction, researchId?: string) {
    if (selectionBusy || (selectionMode === 'text' ? !quote || !pageTextReady : !regionPreview)) return;
    if (!research && !researchId) { setPendingAction(mode); return; }
    const version = selectionVersion.current;
    const originScope = data.scope;
    const selectedDocument = documentId, selectedPage = selectedPageIndex, selectedQuote = quote;
    const selectedTextAnchor = textAnchor;
    const selectedRegion = regionPreview, selectedMode = selectionMode;
    const selectedResearchId = researchId ?? research!.id;
    const cardIdToAttach = session.panel.findEvidenceFor;
    setSelectionBusy(true); setSelectionError('');
    try {
      if (mode === 'ai' || mode === 'explain' || mode === 'translation' || mode === 'summary') {
        const operation = mode === 'translation' || mode === 'summary' ? mode : 'question';
        const source: InlineAISelection = { documentId: selectedDocument, pageIndex: selectedPage,
          quote: selectedMode === 'text' ? selectedQuote : selectedRegion?.quote ?? '', kind: selectedMode,
          ...(selectedMode === 'text' && selectedTextAnchor ? { textAnchor: selectedTextAnchor } : {}) };
        if (mode === 'translation' && !source.quote.trim()) throw new Error('此区域没有可提取的文字，尚未进行 OCR。可以提问或生成区域摘要。');
        if (selectedMode === 'region' && selectedRegion) {
          const hash = await contentHash(await selectedRegion.blob.arrayBuffer());
          const assetId = crypto.randomUUID();
          await putAsset(assetId, selectedRegion.blob);
          source.region = { assetId, hash, rect: selectedRegion.rect, rotation: selectedRegion.rotation, width: selectedRegion.width, height: selectedRegion.height };
        }
        if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) return;
        actions.associateDocument(selectedResearchId, selectedDocument);
        const id = createInlineConversation(selectedResearchId, source, { operation });
        if (!research) actions.updateData(next => { next.sessions[scopeKey(originScope)].libraryResearchId = selectedResearchId; });
        setInlineInitialAction(mode === 'translation' || mode === 'summary' ? mode : mode === 'explain' ? 'explain' : 'ask');
        setInlinePage(selectedPage);
        setInlineConversationId(id);
        setPendingAction(undefined);
        return;
      }
      actions.associateDocument(selectedResearchId, selectedDocument);
      const beforeIds = new Set(Object.keys(actions.getState().data.evidence));
      let evidenceId: string;
      const existing = Object.values(actions.getState().data.evidence).find(item =>
        (!item.researchId || item.researchId === selectedResearchId) && item.documentId === selectedDocument && item.pageIndex === selectedPage &&
        (selectedMode === 'region' ? item.kind === 'region' && !!item.region && !!selectedRegion && JSON.stringify(rotateRegion(item.region.rect, selectedRegion.rotation - item.region.rotation)) === JSON.stringify(selectedRegion.rect)
          : item.kind !== 'region' && item.quote === selectedQuote && (!selectedTextAnchor || item.textAnchor?.start === selectedTextAnchor.start && item.textAnchor?.end === selectedTextAnchor.end)));
      if (existing) { evidenceId = existing.id; if (existing.contextOnly || existing.annotationHidden) actions.updateData(next => { delete next.evidence[evidenceId].contextOnly; delete next.evidence[evidenceId].annotationHidden; }); }
      else if (selectedMode === 'region' && selectedRegion) {
        const hash = await contentHash(await selectedRegion.blob.arrayBuffer());
        const assetId = crypto.randomUUID();
        await putAsset(assetId, selectedRegion.blob);
        evidenceId = actions.createRegionEvidence({ documentId: selectedDocument, pageIndex: selectedPage, quote: selectedRegion.quote, region: { assetId, hash, rect: selectedRegion.rect, rotation: selectedRegion.rotation, width: selectedRegion.width, height: selectedRegion.height } });
        actions.updateData(next => { next.evidence[evidenceId].researchId = selectedResearchId; });
      } else evidenceId = actions.captureExcerpt(selectedResearchId, { documentId: selectedDocument, pageIndex: selectedPage, quote: selectedQuote, ...(selectedTextAnchor ? { textAnchor: selectedTextAnchor } : {}) });
      if (mode === 'attach') {
        if (!cardIdToAttach) throw new Error('找依据的卡片已关闭，请重新选择。');
        actions.attachEvidenceToCard(cardIdToAttach, evidenceId);
      }
      if (version !== selectionVersion.current || scopeKey(actions.getState().data.scope) !== scopeKey(originScope)) {
        actions.notice('已保存摘录；当前阅读位置已改变，请从摘录列表继续。'); return;
      }
      if (mode === 'excerpt' || mode === 'highlight') {
        recordReaderAction(evidenceId, mode);
        setUndoExcerpt(beforeIds.has(evidenceId) ? undefined : evidenceId);
        actions.notice(beforeIds.has(evidenceId) ? '已摘录，已复用已有原文。' : '已摘录');
      } else if (mode === 'card') {
        const cardId = actions.createCard([evidenceId], '新的观点', '', selectedResearchId);
        recordReaderAction(evidenceId, 'card', cardId);
        actions.openResource({ kind: 'card', id: cardId }, { scope: { kind: 'research', researchId: selectedResearchId }, target: 'inspector' });
      }
      setPendingAction(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : '摘录失败，请重试。';
      setSelectionError(message); actions.notice(message);
    } finally { if (version === selectionVersion.current) setSelectionBusy(false); }
  }
  function removeExcerpt(evidenceId: string) {
    try { actions.removeExcerpt(evidenceId); setUndoExcerpt(undefined); clearSelection(); actions.notice('已取消摘录'); }
    catch (problem) { setSelectionError(problem instanceof Error ? problem.message : '取消摘录失败，请重试。'); }
  }
  function removeMark(evidenceId: string) {
    try { actions.setExcerptMarked(evidenceId, false); setUndoExcerpt(undefined); clearSelection(); actions.notice('已移除原文标记，摘录与引用已保留。'); }
    catch (problem) { setSelectionError(problem instanceof Error ? problem.message : '移除标记失败，请重试。'); }
  }
  function openHighlightedExcerpt(element: HTMLElement, index: number) {
    if (normalize(window.getSelection()?.toString() ?? '')) return;
    const id = element.closest<HTMLElement>('[data-evidence-id]')?.dataset.evidenceId;
    const item = id && data.evidence[id];
    if (!item || item.kind === 'region') return;
    activatePage(index);
    selectionVersion.current++; setQuote(item.quote); setTextAnchor(item.textAnchor); setHistoryOpen(true); setSelectionMode('text'); setSelectionError(''); setInlineConversationId(undefined); setInlinePage(undefined);
    actions.setSelection({ scope: data.scope, viewInstanceId: `reader:${viewScope}:${target}:${documentId}`, selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }], textRange: { documentId, pageIndex: index, quote: item.quote }, evidenceIds: [item.id] });
    const pageLayer = pageHandles.current.get(index)?.layer;
    if (!pageLayer) return;
    const bounds = rangeForTextAnchor(pageLayer, item.quote, item.textAnchor)?.getBoundingClientRect() ?? element.getBoundingClientRect(), pageBounds = pageLayer.getBoundingClientRect();
    anchorPageWidth.current = pageBounds.width;
    setSelectionAnchor({ left: bounds.left - pageBounds.left, top: bounds.top - pageBounds.top, width: bounds.width, height: bounds.height });
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
  const lastInline = inlineResearchId ? Object.values(data.conversations).filter(item => item.researchId === inlineResearchId && item.inlineSource?.documentId === documentId && !item.archived).sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))[0] : undefined;
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
  }
  function inlineSource(evidenceId: string) {
    const item = actions.getState().data.evidence[evidenceId];
    if (!item || item.documentId !== documentId) return;
    actions.openResource({ kind: 'document', id: documentId }, {
      scope: data.scope, target: target === 'inspector' ? 'inspector' : 'main',
      ...(target.startsWith('view:') ? { viewId: target.slice(5) } : {}),
      anchor: { evidenceId, pageIndex: item.pageIndex },
    });
    const height = pageSizes[item.pageIndex]?.height ?? 1;
    navigatePosition({ pageIndex: item.pageIndex, scale: position.scale, offset: Math.max(0, (selectionAnchor.top - 50) / height) }, true);
  }
  function openReaderActivity(activity: ReaderActivity) {
    const conversationId = activity.conversationId ?? (activity.draftId && data.cardDrafts[activity.draftId]?.conversationId);
    const conversation = conversationId ? data.conversations[conversationId] : undefined;
    if (conversation?.inlineSource) {
      setInlinePage(conversation.inlineSource.pageIndex);
      setInlineInitialAction(conversation.inlineSource.operation === 'translation' || conversation.inlineSource.operation === 'summary' ? conversation.inlineSource.operation : 'ask');
      setInlineConversationId(conversation.id);
    } else if (activity.cardId && data.cards[activity.cardId]) {
      actions.openResource({ kind: 'card', id: activity.cardId }, { scope: data.scope, target: 'inspector' });
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
  const selectionActions = (
    <>
      <div className="pdf-selection-actions">
        <button className="text-button pdf-selection-primary" data-inline-trigger={`${target}:ask`} disabled={selectionBusy} onClick={() => void saveSelection('ai')}><MessageCircle size={14} />提问</button>
        <button className="text-button" data-inline-trigger={`${target}:translation`} disabled={selectionBusy || !(selectionMode === 'text' ? quote : regionPreview?.quote)} title={selectionMode === 'region' && !regionPreview?.quote ? '此区域没有可提取文字，尚未进行 OCR' : '翻译所选原文'} onClick={() => void saveSelection('translation')}><Languages size={14} />翻译</button>
        <button className="text-button" data-inline-trigger={`${target}:summary`} disabled={selectionBusy} onClick={() => void saveSelection('summary')}><Layers size={14} />摘要卡片</button>
        <details className="pdf-selection-more"><summary aria-label="更多操作">•••</summary><div>
          {findCard && <button className="text-button" disabled={selectionBusy} onClick={() => void saveSelection('attach')}>作为「{findCard.title}」的依据</button>}
          <button className="text-button" aria-label="摘录" disabled={selectionBusy} onClick={() => void saveSelection('excerpt')}>{selectedExcerpt && !selectedExcerpt.contextOnly ? '已存摘录' : '保存摘录'} <kbd>H</kbd></button>
          <button className="text-button" aria-label="写成卡片" disabled={selectionBusy} onClick={() => void saveSelection('card')}>制作卡片 <kbd>C</kbd></button>
          <button className="text-button" disabled={selectionBusy} onClick={() => void saveSelection('highlight')}>高亮</button>
          <button className="text-button" data-inline-trigger={`${target}:explain`} disabled={selectionBusy} onClick={() => void saveSelection('explain')}>解释这段</button>
          {selectedExcerpt && <button className="text-button" disabled={selectionBusy} title="移除原文标记，保留摘录、卡片和 AI 引用" onClick={() => removeMark(selectedExcerpt.id)}>移除标记</button>}
        </div></details>
        <button className="icon-button" aria-label="取消原文选区" onClick={clearSelection}><X size={14} /></button>
      </div>
      {selectionMode === 'region' && !regionPreview?.quote && <span className="pdf-selection-hint">未提取到区域文字 · 提问和摘要需要图片理解</span>}
      {selectedExcerpt && (activityByEvidence[selectedExcerpt.id]?.length ?? 0) > 0 && <>
        <button className="reader-activity-toggle text-button" aria-expanded={historyOpen} onClick={() => setHistoryOpen(value => !value)}>此处记录 <span>{activityByEvidence[selectedExcerpt.id].length}</span></button>
        {historyOpen && <ReaderActivityList activities={activityByEvidence[selectedExcerpt.id]} onOpen={openReaderActivity} />}
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
        if (event.key === 'Escape' && (quote || regionRect || inlineConversationId)) {
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
      {selectionMode === 'region' && !regionPreview && (
        <div className="pdf-region-panel">
          <p>{selectionBusy ? '正在截取所选 PDF 区域…' : '在当前页拖框选择图表或公式，随后可在区域旁直接提问。'}</p>
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
      <div className="pdf-scroll" ref={scroll} onScroll={trackScroll} tabIndex={0} aria-label="连续滚动阅读区域">
        {!pdf && <div className="pdf-loading"><LoaderCircle size={24} className="pdf-spinner" /><p>正在打开原 PDF…</p></div>}
        {pdf && <div className="pdf-page-stack" style={{ paddingBottom: Math.max(0, viewportHeight - (pageSizes.at(-1)?.height ?? 0)) }}>
          {pageSizes.map((size, index) => {
            const selected = selectedPageIndex === index;
            const source = inlineEvidence?.pageIndex === index && !inlineEvidence.annotationHidden ? inlineEvidence : sourceValid && sourceEvidence.pageIndex === index ? sourceEvidence : undefined;
            const sourceRegion = source?.kind === 'region' && source.region ? rotateRegion(source.region.rect, size.rotation - source.region.rotation) : undefined;
            return <PdfPage key={index} pdf={pdf} documentId={documentId} title={doc.title} pageIndex={index} size={size}
              active={Math.abs(index - pageIndex) <= 2 || (!!quote || !!regionRect) && selected}
              selectionMode={selectionMode} excerpts={documentMarks.filter(item => item.pageIndex === index)} source={source}
              activityCounts={Object.fromEntries(Object.entries(activityByEvidence).map(([id, items]) => [id, items.length]))} retry={textRetry}
              onUpdate={handle => { if (handle) pageHandles.current.set(index, handle); else pageHandles.current.delete(index); refreshPages(value => value + 1); }}
              onTextError={() => { setTextState('error'); actions.updateData(next => { if (next.documents[documentId]) next.documents[documentId].textStatus = 'error'; }); }}
              onError={message => setError(message)}
              onSelect={() => captureSelection(index)} onExcerptClick={element => openHighlightedExcerpt(element, index)}>
              {documentMarks.filter(item => item.pageIndex === index && item.kind === 'region' && item.region).map(item => {
                const rect = rotateRegion(item.region!.rect, size.rotation - item.region!.rotation);
                return <div key={item.id} className={`pdf-saved-region ${item.contextOnly ? 'pdf-activity-region' : ''}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
                  <button className="pdf-region-activity-marker" aria-label={`查看此处记录 · ${activityByEvidence[item.id]?.length || 1}条`} onClick={() => {
                    clearSelection(); activatePage(index); setSelectionMode('region'); setRegionRect(rect); setHistoryOpen(true);
                    actions.setSelection({ scope: data.scope, viewInstanceId: `reader:${viewScope}:${target}:${documentId}`, selectedItems: [{ resourceRef: { kind: 'document', id: documentId } }], evidenceIds: [item.id] });
                    void previewRegion(rect, index);
                  }}>{activityByEvidence[item.id]?.length || 1}</button>
                </div>;
              })}
              {sourceRegion && <div className="pdf-region-source" aria-label="来源区域高亮" style={{ left: `${sourceRegion.x * 100}%`, top: `${sourceRegion.y * 100}%`, width: `${sourceRegion.width * 100}%`, height: `${sourceRegion.height * 100}%` }} />}
              {selectionMode === 'region' && <div className="pdf-region-layer" aria-label={index === pageIndex ? '拖动框选当前 PDF 页区域' : `拖动框选 PDF 第 ${index + 1} 页区域`} onPointerDown={event => startRegion(event, index)} onPointerMove={moveRegion} onPointerUp={event => finishRegion(event, index)} onPointerCancel={() => { dragStart.current = undefined; }} onKeyDown={event => { if (event.key === 'Escape') clearSelection(); }} tabIndex={0}>
                {selected && regionRect && <div className="pdf-region-box" style={{ left: `${regionRect.x * 100}%`, top: `${regionRect.y * 100}%`, width: `${regionRect.width * 100}%`, height: `${regionRect.height * 100}%` }} />}
              </div>}

            </PdfPage>;
          })}
        </div>}
      </div>
      {inlineConversationId && inlinePage !== undefined && <ReaderPopover key={`inline:${inlineConversationId}`} anchor={selectionAnchor} pageElement={pageHandles.current.get(inlinePage)?.layer} boundary={scroll.current} className="inline-ai">
        <InlineAIPopover conversationId={inlineConversationId} initialAction={inlineInitialAction} onClose={closeInline} onSource={inlineSource} />
      </ReaderPopover>}
      {!inlineConversationId && (quote && selectionMode === 'text' || regionPreview && selectionMode === 'region') && <ReaderPopover anchor={selectionAnchor} pageElement={pageHandles.current.get(selectedPageIndex)?.layer} boundary={scroll.current} className="pdf-selection-menu" label="原文选区操作">
        <div className="pdf-selection-meta"><span>PDF 第 {selectedPageIndex + 1} 页{quote ? ` · ${quote.length} 字符` : ' · 所选区域'}</span>
          <details className="pdf-selection-preview"><summary>查看所选{quote ? '原文' : '区域'}</summary>{quote ? <blockquote>{quote}</blockquote> : regionPreview && <img className="pdf-inline-region-preview" src={regionPreview.url} alt={`所选区域预览，PDF 第 ${selectedPageIndex + 1} 页`} />}</details>
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
