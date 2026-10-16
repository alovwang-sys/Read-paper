import { useEffect, useId, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import { ImportPDFButton } from '../reader/ImportPDFButton';
import './composer-materials.css';

export function ComposerMaterials({ researchId, conversationId, disabled }: { researchId: string; conversationId: string; disabled?: boolean }) {
  const { data, actions } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const research = data.researches[researchId];
  const conversation = data.conversations[conversationId];
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const evidence = Object.values(data.evidence).filter(item => research?.documentIds.includes(item.documentId) && `${data.documents[item.documentId]?.title ?? ''} ${item.quote}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <>
    <button ref={trigger} type="button" className="composer-add-material" aria-label="添加材料" title="添加论文与原文证据" disabled={disabled} aria-haspopup="dialog" onClick={() => { setSearch(''); setError(''); setOpen(true); }}><Plus size={18} /></button>
    <dialog ref={dialog} className="composer-materials-dialog" aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }} onCancel={event => { event.preventDefault(); setOpen(false); }} onClose={() => { setOpen(false); trigger.current?.focus(); }}>
      <header><h2 id={titleId}>添加对话材料</h2><button type="button" aria-label="关闭添加材料" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <p>从当前研究选择原文证据，加入下一次提问；不会自动发送。</p>
      <input type="search" aria-label="搜索研究证据" placeholder="搜索论文标题或原文摘录…" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="composer-material-options">
        {evidence.map(item => {
          const added = conversation?.contextIds.includes(item.id);
          return <button type="button" key={item.id} disabled={added || disabled} onClick={() => {
            try { actions.addContext({ researchId, conversationId, evidenceIds: [item.id] }); setError(''); }
            catch (caught) { setError(caught instanceof Error ? caught.message : '材料暂时无法添加，请重试。'); }
          }}><strong>{data.documents[item.documentId]?.title} · PDF 第 {item.pageIndex + 1} 页</strong><span>{item.quote || '已保存的原文区域'}</span><small>{added ? <><Check size={13} />已加入本轮</> : '加入本轮'}</small></button>;
        })}
        {!evidence.length && <p>{search ? '没有找到匹配的证据。' : '还没有原文证据。在中央打开论文，选取原文或框选区域后即可加入对话。'}</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      <footer><ImportPDFButton onImported={() => { setOpen(false); actions.notice('论文已导入研究，选取原文后可加入对话，当前问题已保留。'); }} /><button type="button" onClick={() => setOpen(false)}>完成</button></footer>
    </dialog>
  </>;
}
