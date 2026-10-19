import { useEffect, useId, useRef, useState } from 'react';
import { Check, Ellipsis, FolderOpen, LoaderCircle, X } from 'lucide-react';
import { bindResearchDirectory, browseResearchDirectories, getResearchDirectory, previewResearchDirectory } from '../../services/agents';
import { chooseDirectory } from '../../services/research-directory';
import { useWorkspace } from '../../services/workspace';
import { DirectoryBrowser } from './DirectoryPicker';
import { ProjectFileStatus } from './ProjectFileStatus';
import './research-directory.css';

export function ResearchDirectory({ researchId, settings = false, label = '选择研究目录' }: { researchId: string; settings?: boolean; label?: string }) {
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
  const [ownerResearchId, setOwnerResearchId] = useState<string>();
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
    setOwnerResearchId(undefined);
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
    setOwnerResearchId(undefined);
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
      actions.notice('项目已连接，名称已与文件夹保持一致。');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '目录连接失败，请重试。');
      if (caught instanceof Error) setOwnerResearchId((caught as Error & { ownerResearchId?: string }).ownerResearchId);
    } finally { setBusy(false); setBinding(false); }
  }
  async function selectDirectory() {
    setBusy(true); setError('');
    try {
      const result = await chooseDirectory(path || undefined);
      if (result.path) { await browse(result.path); return; }
    } catch (caught) { setError(caught instanceof Error ? caught.message : '无法打开目录选择器，请重试。'); }
    finally { setBusy(false); }
  }
  if (!research) return null;
  const status = directory ? checking ? '正在检查' : connected ? '已连接' : '需要重新连接' : '尚未选择目录';
  return <>
    <button ref={trigger} type="button" className={`research-directory-trigger ${settings ? 'is-settings' : ''}`} title={settings ? `项目设置 · ${status}${directory ? `\n${directory.path}` : ''}` : label} aria-label={settings ? `项目设置 · ${research.title}` : label} aria-haspopup="dialog" onClick={show}>
      {settings ? <Ellipsis size={18} /> : <><FolderOpen size={16} /><span>{label}</span></>}
    </button>
    <dialog ref={dialog} className="research-directory-dialog" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); if (!binding) close(); }} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <header><div><h2 id={titleId}>项目设置</h2><p>{research.title}</p></div><button type="button" className="directory-icon-button" aria-label="关闭项目设置" disabled={binding} onClick={close}><X size={18} /></button></header>
      <div className="directory-dialog-content">
        <p className="directory-description">一个研究，一个工作位置。Codex 和其他本机助手沿用此目录，无需在右侧重复选择。</p>
        <p className="directory-connection" role="status">{checking ? <LoaderCircle className="directory-spinner" size={15} /> : <FolderOpen size={15} />}{status}</p>
        {!directory && <button type="button" className="directory-native-picker" disabled={busy} onClick={() => void selectDirectory()}><FolderOpen size={15} />选择文件夹…</button>}
        <DirectoryBrowser path={path} onPathChange={value => { setPath(value); setCandidate(undefined); }} listing={listing} busy={busy} onBrowse={nextPath => void browse(nextPath)} readOnly={!!directory} />
        {directory && <p className="directory-location-note">可重新连接原目录，论文、卡片和已有对话会保留。</p>}
        {!directory && candidate && <div className="directory-preview"><Check size={16} /><div><strong>项目将命名为「{candidate.name || candidate.path}」</strong><p>{candidate.path}</p><small>点击“使用这个目录”后生效，原有资料和输入会保留。</small></div></div>}
        {error && <div className="directory-error" role="alert"><p>{error}</p>{ownerResearchId && data.researches[ownerResearchId] && <button type="button" disabled={busy} onClick={() => { actions.switchResearch(ownerResearchId); close(); }}>打开已有研究</button>}</div>}
        {directory && <ProjectFileStatus key={`${researchId}:${actions.getGeneration()}`} researchId={researchId} />}
        <details className="directory-storage-note"><summary>资料与对话保存在什么位置？</summary><p>目录中的 Papertrail/ 自动保存本研究关联的论文、摘录、卡片、白板和文稿，供本机助手读取。应用同时保留本地恢复副本，完整工作区备份仍使用 ZIP。</p><p>原生会话由各助手保存。打开同一个目录可以读取研究文件；能否直接接续同一条会话，取决于助手原生记录和当前占用状态。</p></details>
        <p className="directory-location-note">目录关联和助手连接分别检查。更换为其他目录需新建研究，已有原生会话不会被迁移。</p>
      </div>
      <footer><button type="button" disabled={binding} onClick={close}>取消</button><button type="button" className="directory-primary" disabled={busy || !candidate || (!!directory && candidate.path !== directory.path)} onClick={() => void bind()}>{binding ? '正在连接…' : busy ? '正在检查…' : directory ? '重新连接目录' : '使用这个目录'}</button></footer>
    </dialog>
  </>;
}
