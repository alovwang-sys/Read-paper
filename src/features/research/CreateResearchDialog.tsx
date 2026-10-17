import { useEffect, useId, useRef, useState } from 'react';
import { Check, Folder, FolderPlus, Link, LoaderCircle, X } from 'lucide-react';
import { browseDirectories, chooseDirectory, createDirectoryDraft, createResearchLater, createResearchWithDirectory, directoryPath, getDirectoryDefaults, previewDirectory } from '../../services/research-directory';
import { useWorkspace } from '../../services/workspace';
import { DirectoryPicker } from './DirectoryPicker';
import './research-directory.css';

type DirectoryFailure = { message: string; code?: string; ownerResearchId?: string };

export function CreateResearchDialog({ onClose }: { onClose: () => void }) {
  const { data, actions } = useWorkspace();
  const [draft] = useState(createDirectoryDraft);
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [parent, setParent] = useState('');
  const [existing, setExisting] = useState<{ path: string; name: string }>();
  const [picker, setPicker] = useState<'parent' | 'existing'>();
  const [loading, setLoading] = useState(true);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DirectoryFailure>();
  const [touched, setTouched] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const errorBox = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const alive = useRef(true);
  const version = useRef(0);
  const id = useId();
  const title = mode === 'new' ? name.trim() : existing?.name ?? '';
  const targetPath = mode === 'new' ? parent && directoryPath(parent, name.trim() || '研究名称') : existing?.path ?? '';
  const invalidName = !title ? '请填写研究名称。' : mode === 'new' && (/[\\/:*?"<>|\u0000-\u001f]/.test(title) || /[. ]$/.test(name) || /^\.+$/.test(title) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(title)) ? '请使用有效文件夹名称，避开保留字符、系统保留名及结尾的句点或空格。' : '';
  const locked = busy || choosing;
  async function defaults() {
    const request = ++version.current;
    setLoading(true); setError(undefined);
    try {
      const result = await getDirectoryDefaults(draft);
      if (alive.current && request === version.current) setParent(result.path);
    } catch (caught) {
      if (alive.current && request === version.current) fail(caught);
    } finally { if (alive.current && request === version.current) setLoading(false); }
  }
  function fail(caught: unknown) {
    const failure = caught instanceof Error ? caught as Error & { code?: string; ownerResearchId?: string } : undefined;
    setError({ message: failure?.message ?? '暂时未能关联目录，输入已保留，请重试。', code: failure?.code, ownerResearchId: failure?.ownerResearchId });
  }
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    nameInput.current?.focus();
    void defaults();
    return () => { alive.current = false; version.current++; opener.current?.focus(); };
  }, []);
  useEffect(() => { if (error) errorBox.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  async function selected(path: string, purpose: 'parent' | 'existing') {
    setPicker(undefined); setError(undefined);
    if (purpose === 'parent') { version.current++; setLoading(false); setParent(path); return; }
    setChoosing(true); setExisting(undefined);
    try { const result = await previewDirectory(draft, { path, mode: 'existing' }); if (alive.current) setExisting(result); }
    catch (caught) { if (alive.current) fail(caught); }
    finally { if (alive.current) setChoosing(false); }
  }
  async function pick(purpose: 'parent' | 'existing') {
    setChoosing(true); setError(undefined);
    try {
      const result = await chooseDirectory(purpose === 'parent' ? parent : existing?.path || parent || undefined);
      if (!alive.current) return;
      if (!result.supported) setPicker(purpose);
      else if (result.path) await selected(result.path, purpose);
    } catch (caught) { if (alive.current) fail(caught); }
    finally { if (alive.current) setChoosing(false); }
  }
  async function submit() {
    setTouched(true);
    if (invalidName || !targetPath || busy || choosing) return;
    setBusy(true); setError(undefined);
    try {
      await createResearchWithDirectory(draft, { title, question, path: targetPath, mode });
      actions.notice('研究已创建，右侧助手将沿用研究目录。');
      onClose();
    } catch (caught) { if (alive.current) fail(caught); }
    finally { if (alive.current) setBusy(false); }
  }
  function later() {
    if (!title || locked) { setTouched(true); return; }
    try { createResearchLater({ title, question }); actions.notice('研究已创建，可在项目设置中关联目录。'); onClose(); }
    catch (caught) { fail(caught); }
  }
  function changeMode(next: 'new' | 'existing') { setMode(next); setError(undefined); setTouched(false); }
  const owner = error?.ownerResearchId && data.researches[error.ownerResearchId];
  const exists = ['directory_exists', 'path_exists', 'exists'].includes(error?.code ?? '');
  return <>
    <dialog ref={dialog} className="research-directory-dialog create-research-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); if (!locked) onClose(); }}>
      <form noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
        <header><div className="directory-dialog-symbol"><FolderPlus size={23} /></div><div className="directory-dialog-heading"><h2 id={`${id}-title`}>新建研究</h2><p id={`${id}-description`}>给问题一个位置，让研究和助手从这里开始。</p></div><button type="button" className="directory-icon-button" aria-label="取消新建研究" disabled={locked} onClick={onClose}><X size={18} /></button></header>
        <div className="directory-dialog-content">
          <div className="directory-field"><label htmlFor={`${id}-name`}>研究名称 <span>{mode === 'new' ? '同时作为文件夹名称' : '采用所选文件夹名称'}</span></label><input ref={nameInput} id={`${id}-name`} aria-label="研究名称" aria-invalid={touched && !!invalidName} aria-describedby={touched && invalidName ? `${id}-name-error` : undefined} value={mode === 'new' ? name : existing?.name ?? ''} readOnly={mode === 'existing'} disabled={locked} maxLength={80} placeholder={mode === 'new' ? '例如：长文档中的可靠检索' : '选择目录后自动填写'} autoComplete="off" onChange={event => { setName(event.target.value); if (parent) setError(undefined); }} onBlur={() => setTouched(true)} />
            {touched && invalidName && <p className="directory-field-error" id={`${id}-name-error`} role="alert">{mode === 'existing' ? '请选择已有目录。' : invalidName}</p>}
          </div>
          <div className="directory-field"><label htmlFor={`${id}-question`}>研究问题 <span>可选，以后可以修改</span></label><textarea id={`${id}-question`} aria-label="新研究核心问题" rows={2} value={question} disabled={locked} placeholder="这次研究，你最想弄清楚什么？" onChange={event => setQuestion(event.target.value)} /></div>
          <div className="directory-field-label">研究目录</div>
          <div className="create-directory-block">
            <div className="directory-mode-tabs" role="tablist" aria-label="目录方式" onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || locked) return;
              event.preventDefault(); const next = event.key === 'Home' ? 'new' : event.key === 'End' ? 'existing' : mode === 'new' ? 'existing' : 'new';
              changeMode(next); document.getElementById(`${id}-mode-${next}`)?.focus();
            }}>
              <button type="button" role="tab" id={`${id}-mode-new`} aria-controls={`${id}-panel-new`} aria-selected={mode === 'new'} tabIndex={mode === 'new' ? 0 : -1} disabled={locked} onClick={() => changeMode('new')}>新建目录</button><button type="button" role="tab" id={`${id}-mode-existing`} aria-controls={`${id}-panel-existing`} aria-selected={mode === 'existing'} tabIndex={mode === 'existing' ? 0 : -1} disabled={locked} onClick={() => changeMode('existing')}>使用已有目录</button>
            </div>
            {mode === 'new' ? <div role="tabpanel" id={`${id}-panel-new`} aria-labelledby={`${id}-mode-new`}>
              <div className="directory-location-label">在此位置创建</div><div className="directory-location-row"><Folder size={17} /><span title={parent} className="directory-path-text">{loading ? '正在获取默认位置…' : parent || '请选择一个可写位置'}</span><button type="button" disabled={locked} onClick={() => void pick('parent')}>更改</button></div>
              <div className="directory-preview create-directory-preview"><div><span className="directory-preview-caption">将创建并关联</span><p>{parent ? <>{parent.replace(/[\\/]$/, '')}{parent.includes('\\') ? '\\' : '/'}<strong>{name.trim() || '研究名称'}</strong></> : '选择位置后显示完整路径'}</p></div></div>
            </div> : <div role="tabpanel" id={`${id}-panel-existing`} aria-labelledby={`${id}-mode-existing`} className="directory-existing-pick"><Folder size={21} /><div><span className="directory-path-text">{existing?.path ?? '尚未选择目录'}</span><small>研究名称将采用所选文件夹名称。</small></div><button type="button" disabled={locked} onClick={() => void pick('existing')}>{existing ? '更改' : '选择目录'}</button></div>}
          </div>
          <div className="directory-sync-notice"><Link size={17} /><div><strong>选择一次，Codex 自动沿用</strong><p>本研究的本机助手使用同一目录，无需在右侧重复选择。</p></div></div>
          <p className="directory-create-storage">论文、摘录、卡片和文稿会自动保存到目录中的 <span>Papertrail/</span>，供本机助手读取；助手连接与目录关联分别检查。</p>
          {choosing && <p className="directory-connection" role="status"><LoaderCircle className="directory-spinner" size={15} />正在选择并检查目录…</p>}
          {error && <div ref={errorBox} className="directory-error" role="alert"><strong>{owner ? '此目录已属于另一个研究' : exists ? '同名目录已经存在' : '暂时未能关联目录'}</strong><p>{error.message}</p><div className="directory-error-actions">
            {owner && <button type="button" disabled={locked} onClick={() => { actions.switchResearch(owner.id); onClose(); }}>打开已有研究</button>}
            {exists && <><button type="button" disabled={locked} onClick={() => { setError(undefined); nameInput.current?.focus(); nameInput.current?.select(); }}>修改名称</button><button type="button" disabled={locked} onClick={() => { setMode('existing'); void selected(targetPath, 'existing'); }}>使用已有目录</button></>}
            <button type="button" disabled={locked} onClick={() => void pick(mode === 'new' ? 'parent' : 'existing')}>{mode === 'new' ? '更换位置' : '选择其他目录'}</button>
            {!owner && !exists && <button type="button" disabled={locked} onClick={() => { if (parent || mode === 'existing') void submit(); else void defaults(); }}>重试</button>}
          </div><small>表单与输入已保留。</small></div>}
        </div>
        <footer><button type="button" className="directory-later" disabled={!title || locked} onClick={later}>稍后设置目录</button><button type="button" disabled={locked} onClick={onClose}>取消</button><button type="submit" className="directory-primary" disabled={!!invalidName || !targetPath || locked || (mode === 'new' && loading)}>{busy ? <><LoaderCircle className="directory-spinner" size={15} />正在关联…</> : <><Check size={15} />创建并关联</>}</button></footer>
      </form>
    </dialog>
    {picker && <DirectoryPicker title={picker === 'parent' ? '选择父位置' : '选择已有目录'} initialPath={picker === 'parent' ? parent || undefined : existing?.path || parent || undefined} browse={path => browseDirectories(draft, path)} onClose={() => setPicker(undefined)} onChoose={path => void selected(path, picker)} />}
  </>;
}
