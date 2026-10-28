import { useEffect, useId, useRef, useState } from 'react';
import { Check, Folder, FolderOpen, FolderPlus, LoaderCircle, X } from 'lucide-react';
import { browseDirectories, chooseDirectory, createDirectoryDraft, createResearchLater, createResearchWithDirectory, directoryPath, folderNameProblem, getDirectoryDefaults, makeDirectory } from '../../services/research-directory';
import { useWorkspace } from '../../services/workspace';
import { DirectoryPicker } from './DirectoryPicker';
import './research-directory.css';

type Failure = { message: string; code?: string; ownerResearchId?: string; path?: string };
const basename = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

/**
 * Agent workbench creation: Enter makes a same-named folder beside the last research and binds it.
 * Choosing a folder (including one made in the picker) binds that folder directly instead.
 */
export function QuickCreateResearch({ defaultTitle, onClose }: { defaultTitle: string; onClose: () => void }) {
  const { data, actions } = useWorkspace();
  const [draft] = useState(createDirectoryDraft);
  const [name, setName] = useState(defaultTitle);
  const [parent, setParent] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'choose'>();
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<Failure>();
  // Enter pressed before the default location resolves is kept and runs once it arrives.
  const [queued, setQueued] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const alive = useRef(true);
  const id = useId();
  const problem = folderNameProblem(name);
  const locked = !!busy;
  function fail(caught: unknown, path?: string) {
    const failure = caught as Error & { code?: string; ownerResearchId?: string };
    setError({ message: failure?.message || '暂时未能关联目录，输入已保留，请重试。', code: failure?.code, ownerResearchId: failure?.ownerResearchId, path });
  }
  async function defaults() {
    setLoading(true); setError(undefined);
    try { const result = await getDirectoryDefaults(draft); if (alive.current) setParent(result.path); }
    catch (caught) { if (alive.current) { setQueued(false); fail(caught); } }
    finally { if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    nameInput.current?.focus(); nameInput.current?.select();
    void defaults();
    return () => { alive.current = false; opener.current?.focus(); };
  }, []);
  function finish(message: string) {
    actions.notice(message);
    onClose();
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.research-agent-input')?.focus());
  }
  useEffect(() => { if (queued && parent) { setQueued(false); void create(); } }, [queued, parent]);
  async function create() {
    if (problem || locked) return;
    if (!parent) { if (loading) setQueued(true); return; }
    setBusy('create'); setError(undefined);
    const base = name.trim(), untouched = base === defaultTitle;
    let title = base, path = directoryPath(parent, title);
    try {
      // An untouched default name moves past folders left by earlier researches instead of stopping.
      for (let attempt = 2; ; attempt++) {
        try { await createResearchWithDirectory(draft, { title, question: '', path, mode: 'new' }); break; }
        catch (caught) {
          if (!untouched || (caught as { code?: string }).code !== 'directory_exists' || attempt > 50) throw caught;
          title = `${base} ${attempt}`; path = directoryPath(parent, title);
        }
      }
      if (alive.current) finish(`研究已创建，并关联新文件夹 ${path}`);
    } catch (caught) { if (alive.current) fail(caught, path); }
    finally { if (alive.current) setBusy(undefined); }
  }
  async function useFolder(path: string) {
    setPicker(false); setBusy('choose'); setError(undefined);
    try {
      await createResearchWithDirectory(draft, { title: basename(path), question: '', path, mode: 'existing' });
      if (alive.current) finish(`研究已创建，并关联文件夹 ${path}`);
    } catch (caught) { if (alive.current) fail(caught, path); }
    finally { if (alive.current) setBusy(undefined); }
  }
  async function chooseFolder() {
    setError(undefined);
    try {
      const result = await chooseDirectory(parent || undefined);
      if (!alive.current) return;
      if (!result.supported) setPicker(true);
      else if (result.path) await useFolder(result.path);
    } catch (caught) { if (alive.current) fail(caught); }
  }
  function later() {
    if (problem || locked) return;
    try { createResearchLater({ title: name.trim(), question: '' }); finish('研究已创建；目录服务恢复后可从研究名旁“…”关联。'); }
    catch (caught) { fail(caught); }
  }
  const owner = error?.ownerResearchId ? data.researches[error.ownerResearchId] : undefined;
  const exists = error?.code === 'directory_exists';
  const unavailable = !!error && (!error.code || error.code === 'directory_timeout') && !owner;
  const target = parent ? <>{parent.replace(/[\\/]$/, '')}{parent.includes('\\') ? '\\' : '/'}<strong>{name.trim() || '研究名称'}</strong></> : loading ? '正在获取默认位置…' : '默认位置暂不可用';
  return <>
    <dialog ref={dialog} className="research-directory-dialog quick-create-dialog" aria-labelledby={`${id}-title`} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
      <form noValidate onSubmit={event => { event.preventDefault(); void create(); }}>
        <header><div className="directory-dialog-symbol"><FolderPlus size={21} /></div><div className="directory-dialog-heading"><h2 id={`${id}-title`}>新建研究</h2><p>研究与本机助手共用一个文件夹，回车即可开始。</p></div><button type="button" className="directory-icon-button" aria-label="取消新建研究" disabled={locked} onClick={onClose}><X size={18} /></button></header>
        <div className="directory-dialog-content">
          <div className="directory-field"><label htmlFor={`${id}-name`}>研究名称 <span>同时作为新文件夹名称</span></label>
            <input ref={nameInput} id={`${id}-name`} aria-label="新研究名称" aria-invalid={!!problem} value={name} maxLength={80} disabled={locked} autoComplete="off" onChange={event => { setName(event.target.value); setError(undefined); }} />
            {problem && name && <p className="directory-field-error" role="alert">{problem}</p>}
          </div>
          <div className="quick-create-target" aria-live="polite"><Folder size={16} /><div><span className="directory-preview-caption">将新建并关联</span><p className="directory-path-text">{target}</p></div></div>
          <button type="button" className="quick-create-choose" disabled={locked} onClick={() => void chooseFolder()}>{busy === 'choose' ? <LoaderCircle className="directory-spinner" size={15} /> : <FolderOpen size={15} />}选择文件夹作研究目录（可在其中新建）…</button>
          {error && <div className="directory-error" role="alert"><strong>{owner ? '此目录已属于另一个研究' : exists ? '同名文件夹已经存在' : unavailable ? '目录服务暂不可用' : '暂时未能关联目录'}</strong><p>{error.message}</p><div className="directory-error-actions">
            {owner && <button type="button" disabled={locked} onClick={() => { actions.switchResearch(owner.id); onClose(); }}>打开已有研究</button>}
            {exists && error.path && <button type="button" disabled={locked} onClick={() => void useFolder(error.path!)}>直接使用这个文件夹</button>}
            {unavailable && <><button type="button" disabled={locked} onClick={() => void (parent ? create() : defaults())}>重试</button><button type="button" disabled={locked || !!problem} onClick={later}>先创建，稍后关联目录</button></>}
          </div></div>}
        </div>
        <footer><button type="button" disabled={locked} onClick={onClose}>取消</button><button type="submit" className="directory-primary" disabled={!!problem || locked || (!parent && !loading)}>{busy === 'create' || queued ? <><LoaderCircle className="directory-spinner" size={15} />正在创建…</> : <><Check size={15} />创建</>}</button></footer>
      </form>
    </dialog>
    {picker && <DirectoryPicker title="选择研究目录" initialPath={parent || undefined} browse={path => browseDirectories(draft, path)} create={(folderParent, folderName) => makeDirectory(draft, folderParent, folderName)} onClose={() => setPicker(false)} onChoose={path => void useFolder(path)} />}
  </>;
}
