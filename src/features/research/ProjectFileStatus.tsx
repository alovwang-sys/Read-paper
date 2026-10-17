import { useState } from 'react';
import { syncResearchFiles, useProjectFiles } from '../../services/project-files';

export function ProjectFileStatus({ researchId, compact = false }: { researchId: string; compact?: boolean }) {
  const state = useProjectFiles(researchId);
  const [error, setError] = useState('');
  const save = () => { setError(''); void syncResearchFiles(researchId).catch(failure => setError(failure.message)); };
  if (compact) return <div className={`project-file-compact ${state.status}`} aria-live="polite"><button type="button" title={state.error || error || '研究文件保存在关联目录的 Papertrail/ 中；点击立即更新。'} disabled={state.status === 'saving'} onClick={save}>{state.status === 'saved' ? '目录文件已更新' : state.status === 'saving' ? '正在保存到目录…' : state.status === 'error' ? '目录保存失败 · 重试' : '目录文件等待保存'}</button>{(state.error || error) && <p role="alert">{state.error || error}</p>}</div>;
  return <div className="project-file-status" aria-live="polite">
    <strong>{state.status === 'saved' ? '研究文件已保存到目录' : state.status === 'saving' ? '正在保存研究文件…' : state.status === 'error' ? '目录保存需要处理' : '研究文件等待保存到目录'}</strong>
    <p>{state.error || error || 'PDF、图片、摘录、卡片、白板、文稿与可读会话保存在 Papertrail/；应用同时保留本地恢复副本。'}</p>
    <button type="button" className="text-button" disabled={state.status === 'saving'} onClick={save}>{state.status === 'error' ? '重试保存到目录' : '现在保存到目录'}</button>
  </div>;
}
