import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { exportAllAssets } from '../../data/storage';
import { workspace, useWorkspace } from '../../services/workspace';
import { createWorkspaceBackup, downloadWorkspaceBackup, hasActiveGeneration, readWorkspaceBackup, type WorkspaceBackup } from '../../services/backup';

export function BackupControls() {
  const { data, loaded, loadError } = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<WorkspaceBackup>();
  const [confirmed, setConfirmed] = useState(false);
  const generating = hasActiveGeneration(data);
  const disabled = !!busy || !loaded || !!loadError || generating;
  const run = async (message: string, action: () => Promise<void>) => {
    setBusy(message);
    setError('');
    setNotice('');
    try {
      // Let the busy state paint before constructing a potentially large ZIP.
      await new Promise(resolve => setTimeout(resolve, 0));
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备份操作失败，请重试。');
    } finally {
      setBusy('');
    }
  };
  return (
    <section aria-label="工作区备份与恢复">
      <h3>工作区备份与恢复</h3>
      <p>备份包含全部研究、论文原 PDF、区域图片、卡片、白板、结论与对话，不包含 AI 密钥。可在浏览器、macOS 和 Windows 版本之间迁移。</p>
      <p>单个文件上限 64 MB，全部内容上限 256 MB。请妥善保管含论文和研究内容的备份。</p>
      <p>请使用应用直接导出的原始备份 ZIP，勿重新压缩。</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="button" disabled={disabled} onClick={() => void run('正在导出备份…', async () => {
          let saveFailed = false;
          try { await workspace.flushSave(); } catch { saveFailed = true; }
          const snapshot = structuredClone(workspace.getState().data);
          const blob = await createWorkspaceBackup(snapshot, await exportAllAssets());
          downloadWorkspaceBackup(blob);
          setNotice(saveFailed
            ? '本地保存未成功，备份包含当前编辑，请确认文件保存成功。'
            : '备份已准备好，请在保存窗口中确认保存位置。');
        })}><Download size={14} /> 导出完整备份</button>
        <button className="button" disabled={disabled} onClick={() => input.current?.click()}><Upload size={14} /> 导入备份</button>
      </div>
      <input ref={input} type="file" hidden accept=".zip,application/zip" aria-label="选择工作区备份" onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setPreview(undefined);
        setConfirmed(false);
        void run('正在校验备份…', async () => {
          const backup = await readWorkspaceBackup(file);
          setPreview(backup);
        });
      }} />
      {generating && <p role="status">请先停止正在进行的 AI 生成，再导出或恢复备份。</p>}
      {busy && <p role="status" aria-live="polite">{busy}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {preview && (
        <div aria-label="备份预览">
          <p>备份时间：{new Date(preview.createdAt).toLocaleString('zh-CN')}</p>
          <p>{preview.summary.researches} 个研究 · {preview.summary.documents} 篇论文 · {preview.summary.cards} 张卡片 · {preview.summary.assets} 个文件（{(preview.summary.bytes / 1024 / 1024).toFixed(1)} MB）</p>
          <p>恢复将替换当前全部资料，不会合并。替换前会在本机保留一份恢复副本，仍建议先导出当前工作区。</p>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
            <input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} />
            我确认用此备份替换当前全部资料
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button className="button" disabled={disabled || !confirmed} onClick={() => void run('正在恢复备份，请保持窗口打开…', async () => {
              await workspace.restoreBackup(preview.data, preview.assets);
              setPreview(undefined);
              setConfirmed(false);
              setNotice('备份恢复完成，全部论文和资料已保存到此设备。');
            })}>确认替换并恢复</button>
            <button className="text-button" disabled={!!busy} onClick={() => { setPreview(undefined); setConfirmed(false); }}>取消导入</button>
          </div>
        </div>
      )}
    </section>
  );
}
