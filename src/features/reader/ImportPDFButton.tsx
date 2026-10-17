import { Plus } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import { openAddSource } from '../library/AddSourceDialog';

export function ImportPDFButton({ compact = false, onImported }: { compact?: boolean; onImported?: (documentId: string) => void }) {
  const { data } = useWorkspace();
  return <button className={compact ? 'icon-button' : 'button'} aria-label="添加资料" title="添加资料" onClick={() => openAddSource({ scope: structuredClone(data.scope), onImported })}><Plus size={16}/>{!compact && '添加资料'}</button>;
}
