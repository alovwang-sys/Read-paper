import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, Layers, Quote, Sparkles } from 'lucide-react';
import { getAsset } from '../../data/storage';
import type { ContextSnapshot, RegionSource } from '../../domain/types';
import { useWorkspace, validateEvidence } from '../../services/workspace';
import './evidence.css';

function RegionPreview({ region }: { region: RegionSource }) {
  const [preview, setPreview] = useState<{ assetId: string; url?: string; error?: string }>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    getAsset(region.assetId).then((blob) => {
      if (!blob) throw new Error('区域图片缺失，可回到 PDF 重新框选。');
      if (!active) return;
      url = URL.createObjectURL(blob);
      setPreview({ assetId: region.assetId, url });
    }).catch((error) => {
      if (active) setPreview({ assetId: region.assetId, error: error instanceof Error ? error.message : '区域图片读取失败，请重试。' });
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [region.assetId]);
  if (preview?.assetId !== region.assetId) return <p className="muted" role="status">区域预览加载中…</p>;
  if (preview.error) return <p className="evidence-missing" role="status">{preview.error}</p>;
  return <img className="evidence-region-preview" src={preview.url} alt="保存的 PDF 框选区域" onError={() => setPreview({ assetId: region.assetId, error: '区域图片无法显示，可回到 PDF 查看原区域。' })} />;
}

export function EvidenceList({
  documentId,
  evidenceIds,
  target = 'inspector',
  heading = '原文证据',
  snapshots,
}: {
  documentId?: string;
  evidenceIds?: string[];
  target?: 'main' | 'inspector';
  heading?: string;
  snapshots?: ContextSnapshot[];
}) {
  const { data, research, actions } = useWorkspace();
  const ids =
    evidenceIds ??
    Object.values(data.evidence)
      .filter(
        (item) =>
          (!documentId || item.documentId === documentId) &&
          (!research || research.documentIds.includes(item.documentId)),
      )
      .map((item) => item.id);
  function execute(action: () => void) {
    try {
      action();
    } catch (error) {
      actions.notice(
        error instanceof Error ? error.message : '此操作暂时无法完成。',
      );
    }
  }
  return (
    <div className="evidence-list">
      <div className="evidence-list-heading">
        <span className="section-heading">{heading}</span>
        <span className="muted">{ids.length} 条</span>
      </div>
      {!ids.length && (
        <div className="empty-state compact">
          <Quote size={28} />
          <h3>让观点有据可查</h3>
          <p>在 PDF 中选中原文，创建证据卡片或明确加入 AI 上下文。</p>
        </div>
      )}
      {ids.map((id) => {
        const item = data.evidence[id];
        const doc = item && data.documents[item.documentId];
        const snapshot = snapshots?.find((source) => source.evidenceId === id);
        const versionChanged = !!(snapshot?.documentHash && doc && snapshot.documentHash !== doc.hash);
        let valid = false;
        try { validateEvidence(data, [id]); valid = true; } catch { /* 缺失时仍保留可读摘录。 */ }
        if (!valid || !item || !doc || versionChanged)
          return (
            <div className="evidence-missing" role="alert" key={id}>
              {versionChanged ? '文献版本与创建时的快照不一致。' : '来源引用已缺失或 PDF 页码无效。'}请恢复原论文与证据后重新核查，引用 ID：{id}。
              {snapshot && <p>{snapshot.title} · PDF 第 {snapshot.pageIndex + 1} 页 · 创建时快照</p>}
              {(snapshot?.quote || item?.quote) && <blockquote>{snapshot?.quote || item?.quote}</blockquote>}
              {(snapshot?.kind ?? item?.kind) === 'region' && <p>保存的区域证据</p>}
              {snapshot?.region && <RegionPreview region={snapshot.region} />}
            </div>
          );
        if (research && !research.documentIds.includes(doc.id))
          return (
            <div className="evidence-missing" key={id}>
              此来源尚未关联当前研究。
              <button
                className="text-button"
                onClick={() =>
                  execute(() => actions.associateDocument(research.id, doc.id))
                }
              >
                将论文加入当前研究
              </button>
            </div>
          );
        const open = (destination: 'main' | 'inspector') =>
          execute(() =>
            actions.openResource(
              { kind: 'document', id: doc.id },
              {
                scope: data.scope,
                target: destination,
                anchor: { evidenceId: id, pageIndex: item.pageIndex },
              },
            ),
          );
        return (
          <article className="evidence-entry" key={id} data-evidence-id={id}>
            <div className="evidence-source-label">
              <BookOpen size={13} />
              <span>
                PDF 第 {item.pageIndex + 1} 页
                {item.printedPage ? ` · 印刷页 ${item.printedPage}` : ''}
              </span>
            </div>
            {item.kind === 'region' && item.region && <>
              <p className="evidence-region-label">区域证据 · {item.region.width} × {item.region.height} 像素</p>
              <RegionPreview region={item.region} />
            </>}
            {item.quote && <blockquote>{item.quote}</blockquote>}
            <button
              className="evidence-document-link"
              onClick={() => open(target)}
            >
              {doc.title}
              <ExternalLink size={12} />
            </button>
            <div className="evidence-actions">
              <button className="text-button" onClick={() => open('main')}>
                主区查看原文
              </button>
              <button
                className="text-button"
                onClick={() =>
                  execute(() => {
                    const title = item.quote.trim() || `${doc.title} · PDF 第 ${item.pageIndex + 1} 页区域`;
                    const cardId = actions.createCard([id], title.length > 26 ? `${title.slice(0, 26)}…` : title);
                    actions.openResource(
                      { kind: 'card', id: cardId },
                      { scope: data.scope, target: 'inspector' },
                    );
                  })
                }
              >
                <Layers size={12} />
                形成卡片
              </button>
              {research && (
                <button
                  className="text-button"
                  onClick={() =>
                    execute(() => actions.contextFromEvidence(item))
                  }
                >
                  <Sparkles size={12} />
                  加入 AI
                </button>
              )}
              {!research && <span className="muted">向 AI 提问前，请先选择研究。</span>}
            </div>
          </article>
        );
      })}
    </div>
  );
}
