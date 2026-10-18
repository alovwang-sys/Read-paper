import { useLayoutEffect, useMemo, useRef } from 'react';
import { registerReaderFlush, useWorkspace } from '../../services/workspace';

export function useEditorViewState<T extends HTMLInputElement | HTMLTextAreaElement>(key: string) {
  const { pane, view, actions } = useWorkspace();
  const cache = useMemo(() => ({ values: view?.viewState ?? {} }), [key, pane?.tabId]);
  cache.values = view?.viewState ?? {};
  const ref = useRef<T>(null);
  const frame = useRef<number>(undefined);
  const previousValue = useRef<string>(undefined);
  const persist = (element: T) => {
    if (!pane) return;
    const patch = { [`${key}.selectionStart`]: element.selectionStart ?? 0, [`${key}.selectionEnd`]: element.selectionEnd ?? 0, [`${key}.selectionDirection`]: element.selectionDirection ?? 'none', [`${key}.scrollTop`]: element.scrollTop };
    if (Object.entries(patch).every(([name, value]) => cache.values[name] === value)) return;
    cache.values = { ...cache.values, ...patch };
    actions.setViewState(patch);
  };
  const restore = (element: T) => {
    const start = Number(cache.values[`${key}.selectionStart`] ?? 0), end = Number(cache.values[`${key}.selectionEnd`] ?? 0);
    const direction = cache.values[`${key}.selectionDirection`];
    element.setSelectionRange(start, end, direction === 'backward' || direction === 'forward' ? direction : 'none');
    element.scrollTop = Number(cache.values[`${key}.scrollTop`] ?? 0);
  };
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    restore(element);
    previousValue.current = element.value;
    const flush = () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; persist(element); };
    const scope = pane?.scope.kind === 'research' ? pane.scope.researchId : 'library';
    const unregister = pane ? registerReaderFlush(`editor:${scope}:${pane.tabId}:${key}`, flush) : () => {};
    return () => { unregister(); flush(); };
  }, [key, pane?.tabId]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Updating shared text moves an unfocused native editor's cursor to its end.
    if (element.value !== previousValue.current && document.activeElement !== element) restore(element);
    previousValue.current = element.value;
  });
  const remember = () => {
    const element = ref.current;
    if (!element || !pane) return;
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => { frame.current = undefined; persist(element); });
  };
  return { ref, onSelect: remember, onScroll: remember, onBlur: () => { if (frame.current !== undefined) cancelAnimationFrame(frame.current); if (ref.current) persist(ref.current); } };
}
