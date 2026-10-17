import { useEffect, useRef, useState } from 'react';
import { FilePlus2, Search, Upload, X } from 'lucide-react';
import type { WorkspaceScope } from '../../domain/types';
import { normalizeIdentifier } from '../../domain/knowledge';
import { importPdfFiles } from '../../services/pdf';
import { collectSource, sourceCandidate } from '../../services/sources';
import { scopeKey, useWorkspace } from '../../services/workspace';
import './library.css';

const ADD_SOURCE_EVENT = 'papertrail:add-source';
type AddSourceRequest = { scope?: WorkspaceScope; files?: File[]; onImported?: (documentId: string) => void };
export function openAddSource(request: AddSourceRequest = {}) {
  window.dispatchEvent(new CustomEvent(ADD_SOURCE_EVENT, { detail: request }));
}

export function AddSourceDialog() {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<WorkspaceScope>({ kind: 'library' });
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState<{ filename: string; message: string }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const callback = useRef<AddSourceRequest['onImported']>(undefined);
  const importing = useRef(false);
  const visible = useRef(false);
  const close = () => { if (!visible.current) return; visible.current = false; setOpen(false); trigger.current?.focus(); };
  const importFiles = async (files: File[], scope: WorkspaceScope) => {
    if (!files.length || importing.current) return;
    importing.current = true;
    setBusy(true); setError(''); setFailures([]);
    try {
      const result = await importPdfFiles(files, structuredClone(scope));
      for (const id of result.documentIds) callback.current?.(id);
      setFailures(result.failures);
      if (!result.failures.length) close();
    } catch (error) {
      setError(error instanceof Error ? error.message : '导入失败，请重试。');
    } finally { importing.current = false; setBusy(false); }
  };
  useEffect(() => {
    const show = (event: Event) => {
      if (importing.current) return;
      const request = (event as CustomEvent<AddSourceRequest>).detail ?? {};
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      callback.current = request.onImported;
      visible.current = true;
      const scope = structuredClone(request.scope ?? data.scope);
      setTarget(scope); setQuery(''); setError(''); setFailures([]); setOpen(true);
      if (request.files?.length) void importFiles(request.files, scope);
    };
    window.addEventListener(ADD_SOURCE_EVENT, show);
    return () => window.removeEventListener(ADD_SOURCE_EVENT, show);
  }, [data.scope]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!open) return null;
  const identifier = normalizeIdentifier(query);
  const matches = query.trim() ? Object.values(data.documents).filter(doc =>
    `${doc.title} ${doc.authors} ${Object.values(doc.identifiers ?? {}).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()) ||
    identifier && doc.identifiers?.[identifier.kind] === identifier.value,
  ).slice(0, 8) : [];
  const add = (input: Parameters<typeof actions.addSource>[0]) => {
    try {
      const result = actions.addSource(input, target);
      actions.openResource({ kind: 'document', id: result.documentId }, { scope: target, target: 'main' });
      actions.notice(result.created ? '资料已收下，可在原条目上添加 PDF。' : '已复用资料库中的资料和已有摘录。');
      close();
    } catch (error) { setError(error instanceof Error ? error.message : '添加失败，请重试。'); }
  };
  const collectLink = async () => {
    if (importing.current || !query.trim()) return;
    importing.current = true; setBusy(true); setError('');
    const scope = structuredClone(target);
    try {
      const documentId = await collectSource(sourceCandidate(query), scope);
      callback.current?.(documentId);
      if (visible.current && scopeKey(actions.getState().data.scope) === scopeKey(scope)) actions.openResource({ kind: 'document', id: documentId }, { scope, target: 'main' });
      actions.notice('资料已收下，正在尝试获取文献信息和全文。');
      close();
    } catch (error) { setError(error instanceof Error ? error.message : '保存失败，链接已保留，请重试。'); }
    finally { importing.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal add-source-dialog" role="dialog" aria-modal="true" aria-label="添加资料" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')).filter(element => !element.hidden);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} onDragOver={event => { event.preventDefault(); }} onDrop={event => {
      event.preventDefault(); event.stopPropagation(); void importFiles(Array.from(event.dataTransfer.files), target);
    }}>
      <div className="modal-heading"><h2>添加资料</h2><button className="icon-button" aria-label="关闭添加资料" onClick={close}><X size={18}/></button></div>
      <label className="source-target">添加到：<select aria-label="添加资料的目标研究" value={target.kind === 'library' ? 'library' : target.researchId} disabled={busy} onChange={event => setTarget(event.target.value === 'library' ? { kind: 'library' } : { kind: 'research', researchId: event.target.value })}>
        <option value="library">仅存入资料库（未加入研究）</option>
        {Object.values(data.researches).map(research => <option key={research.id} value={research.id}>{research.title}</option>)}
      </select></label>
      <form onSubmit={event => { event.preventDefault(); if (busy || !query.trim()) return; if (identifier) void collectLink(); else if (matches[0]) add({ kind: 'library', documentId: matches[0].id }); else add({ kind: 'title', title: query }); }}>
        <label className="search-input"><Search size={17}/><input ref={input} aria-label="标识、链接或资料标题" placeholder="粘贴 arXiv、DOI、链接，或搜索标题…" value={query} disabled={busy} onChange={event => { setQuery(event.target.value); setError(''); }}/></label>
        <p className="muted">链接、DOI 或 arXiv：先收下资料，再尝试获取信息和全文。也可搜索已有资料或按标题新建。</p>
        <div className="source-matches">
          {matches.map(doc => {
            const usedBy = Object.values(data.researches).filter(research => research.documentIds.includes(doc.id));
            const linked = target.kind === 'research' && usedBy.some(research => research.id === target.researchId);
            return <button type="button" className="source-match" key={doc.id} disabled={busy} onClick={() => add({ kind: 'library', documentId: doc.id })}><strong>{doc.title}</strong><small>{linked ? '已在本研究中 · 打开' : `用于：${usedBy.map(research => research.title).join('、') || '尚未加入研究'} · 复用原文和已有摘录`}</small></button>;
          })}
          {!!query.trim() && <button className="button source-create" type="button" disabled={busy} onClick={() => identifier ? void collectLink() : add({ kind: 'title', title: query })}><FilePlus2 size={16}/>{busy ? '正在保存资料…' : identifier ? `收下 ${identifier.kind === 'arxiv' ? 'arXiv' : identifier.kind === 'doi' ? 'DOI' : '链接'}：${identifier.value}` : `按标题新建条目：${query.trim()}`}</button>}
        </div>
      </form>
      <button className="source-file-drop" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={23}/><strong>{busy ? '正在保存资料…' : '选择 PDF，或把文件拖到这里'}</strong><span>支持多选 · 每个文件不超过 50 MB</span></button>
      <input ref={fileInput} type="file" accept=".pdf,application/pdf" aria-label="选择 PDF 文件" multiple hidden disabled={busy} onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; void importFiles(files, target); }}/>
      {error && <p role="alert" className="source-error">{error}</p>}
      {!!failures.length && <div role="alert" className="source-error"><strong>部分文件未导入，可重新选择后重试：</strong>{failures.map((failure, index) => <p key={index}>{failure.filename}：{failure.message}</p>)}</div>}
    </section>
  </div>;
}

export function SourceDropZone() {
  const { data } = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const fileDrag = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const enter = (event: DragEvent) => { if (fileDrag(event) && !document.querySelector('[role="dialog"]')) { event.preventDefault(); depth.current++; setDragging(true); } };
    const over = (event: DragEvent) => { if (fileDrag(event)) event.preventDefault(); };
    const leave = () => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); };
    const reset = () => { depth.current = 0; setDragging(false); };
    const drop = (event: DragEvent) => {
      if (!fileDrag(event)) return;
      event.preventDefault();
      if (document.querySelector('[role="dialog"]')) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) openAddSource({ files, scope: structuredClone(data.scope) });
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', reset, true); window.addEventListener('dragend', reset); window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', reset, true); window.removeEventListener('dragend', reset); window.removeEventListener('drop', drop); };
  }, [data.scope]);
  const name = data.scope.kind === 'research' ? data.researches[data.scope.researchId]?.title : '资料库';
  return dragging ? <div className="source-window-drop" role="status"><Upload size={40}/><strong>松开即加入「{name}」</strong></div> : null;
}
