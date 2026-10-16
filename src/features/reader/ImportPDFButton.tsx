import { useRef, useState } from 'react';
import { LoaderCircle, Upload } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import { importPdf } from '../../services/pdf';
import './reader.css';

export function ImportPDFButton({ compact = false }: { compact?: boolean }) {
  const { data } = useWorkspace();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className={`pdf-import ${compact ? 'compact' : ''}`}>
      <button
        className={compact ? 'icon-button' : 'button'}
        aria-label="导入 PDF"
        title="导入 PDF"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <LoaderCircle size={16} className="pdf-spinner" />
        ) : (
          <Upload size={16} />
        )}{' '}
        {!compact && (busy ? '正在导入…' : '导入 PDF')}
      </button>
      <input
        ref={input}
        type="file"
        accept=".pdf,application/pdf"
        aria-label="选择 PDF 文件"
        hidden
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const scope = structuredClone(data.scope);
          setBusy(true);
          setError('');
          try {
            await importPdf(file, scope);
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : '导入失败，请重新选择文件。',
            );
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && (
        <div className="pdf-import-error" role="alert">
          <span>{error}</span>
          <button
            className="text-button"
            onClick={() => input.current?.click()}
          >
            重新选择
          </button>
          <button className="text-button" onClick={() => setError('')}>
            关闭
          </button>
        </div>
      )}
    </div>
  );
}
