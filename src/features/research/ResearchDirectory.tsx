import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, Folder, FolderOpen, RefreshCw, X } from 'lucide-react';
import { bindResearchDirectory, browseResearchDirectories, getResearchDirectory, previewResearchDirectory } from '../../services/agents';
import { useWorkspace } from '../../services/workspace';
import './research-directory.css';

export function ResearchDirectory({ researchId, collapsed = false, label = '研究目录' }: { researchId: string; collapsed?: boolean; label?: string }) {
  const { data, actions } = useWorkspace();
  const research = data.researches[researchId];
  const directory = research?.directory;
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [connected, setConnected] = useState(false);
  const [path, setPath] = useState('');
  const [candidate, setCandidate] = useState<{ path: string; name: string }>();
  const [listing, setListing] = useState<Awaited<ReturnType<typeof browseResearchDirectories>>>();
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const version = useRef(0);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    setConnected(false);
    if (!directory) return;
    const check = () => {
      setChecking(true);
      getResearchDirectory(researchId).then(result => {
        if (!cancelled) setConnected(!!result);
      }).catch(() => { if (!cancelled) setConnected(false); }).finally(() => { if (!cancelled) setChecking(false); });
    };
    check();
    window.addEventListener('focus', check);
    return () => { cancelled = true; window.removeEventListener('focus', check); };
  }, [researchId, directory?.path]);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => { setOpen(false); version.current++; }, [researchId]);

  async function browse(nextPath?: string) {
    const request = ++version.current;
    setBusy(true);
    setError('');
    setCandidate(undefined);
    try {
      const result = await browseResearchDirectories(nextPath, researchId);
      if (request !== version.current) return;
      setListing(result);
      setPath(result.path);
      if (!nextPath) return;
      const preview = await previewResearchDirectory(result.path, researchId);
      if (request === version.current) setCandidate(preview);
    } catch (caught) {
      if (request === version.current) { setConnected(false); setError(caught instanceof Error ? caught.message : '无法读取目录，请检查路径后重试。'); }
    } finally {
      if (request === version.current) setBusy(false);
    }
  }
  function show() {
    setPath(directory?.path ?? '');
    setListing(undefined);
    setCandidate(undefined);
    setError('');
    setOpen(true);
    void browse(directory?.path);
  }
  function close() {
    if (busy) version.current++;
    setBusy(false);
    setOpen(false);
  }
  async function bind() {
    if (!candidate || busy) return;
    setBusy(true);
    setBinding(true);
    setError('');
    try {
      await bindResearchDirectory(researchId, candidate.path);
      setConnected(true);
      setOpen(false);
      actions.notice('研究目录已连接；原有资料和对话已保留。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '目录连接失败，请重试。');
    } finally { setBusy(false); setBinding(false); }
  }
  if (!research) return null;
  const status = directory ? checking ? '检查中' : connected ? '已连接' : '待重连' : '待选择';
  return <>
    <button ref={trigger} type="button" className={`research-directory-trigger ${collapsed ? 'is-collapsed' : ''}`} title={directory?.path ?? '为这个研究选择目录'} aria-label={`研究目录 · ${status}`} onClick={show}>
      <FolderOpen size={16} />
      {!collapsed && <><span>{label}</span><small>{status}</small></>}
    </button>
    <dialog ref={dialog} className="research-directory-dialog" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); if (!binding) close(); }} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <header><div><h2 id={titleId}>研究目录</h2><p>{research.title}</p></div><button type="button" className="directory-icon-button" aria-label="关闭研究目录" disabled={binding} onClick={close}><X size={18} /></button></header>
      <div className="directory-dialog-content">
        <p className="directory-description">此研究的原生对话将归到这个目录。浏览和预览不会移动资料或创建文件。</p>
        {directory && <div className="directory-current"><strong>当前绑定</strong><p>{directory.path}</p><small>已有会话保留原目录归属。此处可以重新连接同一目录。</small></div>}
        <form className="directory-path-form" onSubmit={event => { event.preventDefault(); if (!busy) void browse(path.trim() || undefined); }}>
          <label htmlFor={`${titleId}-path`}>本机目录路径</label>
          <div><input id={`${titleId}-path`} value={path} onChange={event => { setPath(event.target.value); setCandidate(undefined); }} placeholder="输入绝对路径，或浏览下方目录" readOnly={!!directory} spellCheck={false} /><button type="submit" disabled={busy}><RefreshCw size={14} />{directory ? '重新检查' : '打开路径'}</button></div>
        </form>
        {!directory && <div className="directory-browser" aria-busy={busy}>
          <div className="directory-browser-heading"><span>选择已有目录</span><button type="button" disabled={busy || !listing?.parent} onClick={() => void browse(listing?.parent)}><ArrowUp size={14} />上一级</button></div>
          <div className="directory-folders">
            {listing?.directories.map(item => <button type="button" key={item.path} disabled={busy} onClick={() => void browse(item.path)}><Folder size={17} /><span>{item.name}</span><ChevronRight size={15} /></button>)}
            {!busy && listing && !listing.directories.length && <p>这个目录没有子目录，可以直接使用当前目录。</p>}
            {busy && !listing && <p role="status">正在读取本机目录…</p>}
          </div>
        </div>}
        {candidate && <div className="directory-preview"><Check size={16} /><div><strong>{candidate.name || candidate.path}</strong><p>{candidate.path}</p><small>{directory ? '目录可访问，确认后重新连接。' : '点击“使用这个目录”后才保存关联。'}</small></div></div>}
        {error && <p className="directory-error" role="alert">{error}</p>}
        <details className="directory-storage-note"><summary>资料与对话保存在什么位置？</summary><p>研究目录用于项目归属，原生记录仍由各助手保存。当前浏览器中的论文、卡片和笔记不会因绑定目录自动迁移。</p></details>
      </div>
      <footer><button type="button" disabled={binding} onClick={close}>取消</button><button type="button" className="directory-primary" disabled={busy || !candidate || (!!directory && candidate.path !== directory.path)} onClick={() => void bind()}>{binding ? '正在连接…' : busy ? '正在检查…' : directory ? '重新连接目录' : '使用这个目录'}</button></footer>
    </dialog>
  </>;
}
