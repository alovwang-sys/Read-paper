import { useEffect, useState } from 'react';
import { pendingResearch, resumePendingResearch } from '../../services/research-directory';
import { workspace } from '../../services/workspace';

export function PendingResearchRecovery() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function recover() {
    setBusy(true);
    try {
      if (pendingResearch()) { await resumePendingResearch(); workspace.notice('已恢复上一次研究创建，目录与内容均已保留。'); }
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '研究创建结果尚待确认。'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void recover(); }, []);
  return error ? <div className="pending-research-recovery" role="alert"><div><strong>上一次研究创建尚待确认</strong><p>{error}</p></div><button type="button" className="button" disabled={busy} onClick={() => void recover()}>{busy ? '正在核对…' : '重试恢复创建'}</button></div> : null;
}
