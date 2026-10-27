import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../../services/workspace';
import { ManagementDialog } from '../ai/ConversationManagement';

export function BoardRenameDialog({ boardId, onClose }: { boardId: string; onClose: () => void }) {
  const { data, actions } = useWorkspace();
  const board = data.boards[boardId];
  const [name, setName] = useState(() => data.sessions[board?.researchId ?? '']?.boardTitleDrafts?.[boardId] ?? board?.title ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const composing = useRef(false), pending = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (!board) return null;
  const researchId = board.researchId;
  function change(value: string) {
    setName(value);
    try {
      actions.updateData(next => {
        const session = next.sessions[researchId];
        if (!session || next.boards[boardId]?.researchId !== researchId) throw new Error('白板或所属研究已不存在，输入已保留。');
        (session.boardTitleDrafts ??= {})[boardId] = value;
      });
      setError('');
    } catch (problem) { setError(problem instanceof Error ? problem.message : '名称草稿暂未保存，输入已保留。'); }
  }
  async function save() {
    if (pending.current || composing.current || !name.trim()) return;
    pending.current = true; setSaving(true); setError('');
    try {
      actions.renameBoard(boardId, name);
      await actions.flushSave();
      actions.updateData(next => {
        const drafts = next.sessions[researchId]?.boardTitleDrafts;
        if (drafts?.[boardId] === name) delete drafts[boardId];
      });
      if (mounted.current) onClose();
    } catch (problem) {
      if (mounted.current) setError(problem instanceof Error ? problem.message : '暂时无法保存名称，输入已保留，请重试。');
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const close = () => { if (!pending.current) onClose(); };
  return <ManagementDialog title="重命名白板" closeLabel="取消重命名白板" onClose={close}>
    <form className="conversation-rename-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>白板名称<input data-dialog-autofocus value={name} maxLength={160} disabled={saving} onChange={event => change(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => {
        if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && (event.key === 'Enter' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); }
      }}/></label>
      {error && <p className="conversation-management-error" role="alert">{error}</p>}
      <footer><button type="button" className="conversation-management-cancel" disabled={saving} onClick={close}>取消</button><button type="submit" className="conversation-management-save" disabled={saving || !name.trim()}>{saving ? '正在保存…' : '保存名称'}</button></footer>
    </form>
  </ManagementDialog>;
}
