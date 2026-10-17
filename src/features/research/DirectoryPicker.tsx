import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, Folder, X } from 'lucide-react';
import './research-directory.css';

export type DirectoryListing = { path: string; parent?: string; directories: { name: string; path: string }[] };

export function DirectoryBrowser({ path, onPathChange, listing, busy, onBrowse, readOnly = false }: {
  path: string;
  onPathChange: (path: string) => void;
  listing?: DirectoryListing;
  busy: boolean;
  onBrowse: (path?: string) => void;
  readOnly?: boolean;
}) {
  const pathId = useId();
  return <>
    <div className="directory-path-form">
      <label htmlFor={pathId}>{readOnly ? '项目位置' : '本机目录路径'}</label>
      <div><input id={pathId} value={path} disabled={busy} onChange={event => onPathChange(event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (!busy) onBrowse(path.trim() || undefined); }
      }} placeholder="输入绝对路径，或浏览下方目录" readOnly={readOnly} spellCheck={false} />
        <button type="button" disabled={busy} onClick={() => onBrowse(path.trim() || undefined)}>{readOnly ? '重新检查' : '打开路径'}</button></div>
    </div>
    {!readOnly && <div className="directory-browser" aria-busy={busy}>
      <div className="directory-browser-heading"><span>选择已有目录</span><button type="button" disabled={busy || !listing?.parent} onClick={() => onBrowse(listing?.parent)}><ArrowUp size={14} />上一级</button></div>
      <div className="directory-folders">
        {listing?.directories.map(item => <button type="button" key={item.path} disabled={busy} onClick={() => onBrowse(item.path)}><Folder size={17} /><span>{item.name}</span><ChevronRight size={15} /></button>)}
        {!busy && listing && !listing.directories.length && <p>这个目录没有子目录，可以直接使用当前目录。</p>}
        {busy && !listing && <p role="status">正在读取本机目录…</p>}
      </div>
    </div>}
  </>;
}

export function DirectoryPicker({ title, initialPath, browse, onChoose, onClose }: {
  title: string;
  initialPath?: string;
  browse: (path?: string) => Promise<DirectoryListing>;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const version = useRef(0);
  const titleId = useId();
  const [path, setPath] = useState(initialPath ?? '');
  const [listing, setListing] = useState<DirectoryListing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(nextPath?: string) {
    const request = ++version.current;
    setBusy(true); setError('');
    try {
      const result = await browse(nextPath);
      if (request === version.current) { setListing(result); setPath(result.path); }
    } catch (caught) {
      if (request === version.current) setError(caught instanceof Error ? caught.message : '无法读取目录，请检查路径后重试。');
    } finally { if (request === version.current) setBusy(false); }
  }
  useEffect(() => {
    dialog.current?.showModal();
    void load(initialPath);
    return () => { version.current++; opener.current?.focus(); };
  }, []);
  return <dialog ref={dialog} className="research-directory-dialog directory-picker-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}>
    <header><div><h2 id={titleId}>{title}</h2><p>浏览本机文件夹，确认后使用此位置。</p></div><button type="button" className="directory-icon-button" aria-label="取消选择位置" onClick={onClose}><X size={18} /></button></header>
    <div className="directory-dialog-content">
      <DirectoryBrowser path={path} onPathChange={value => { setPath(value); setError(''); }} listing={listing} busy={busy} onBrowse={nextPath => void load(nextPath)} />
      {listing && <p className="directory-picker-current">当前位置 <span>{listing.path}</span></p>}
      {error && <p className="directory-error" role="alert">{error}</p>}
    </div>
    <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="directory-primary" disabled={busy || !listing || !!error || path !== listing.path} onClick={() => listing && onChoose(listing.path)}>使用此位置</button></footer>
  </dialog>;
}
