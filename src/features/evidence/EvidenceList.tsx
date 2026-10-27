import { useEffect, useState } from 'react';
import { BookOpen, ExternalLink, Layers, Quote, Sparkles } from 'lucide-react';
import { getAsset } from '../../data/storage';
import type { ContextSnapshot, RegionSource } from '../../domain/types';
import { evidenceGroup, pageRangeLabel } from '../../domain/evidence';
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
  showNote = false,
}: {
  documentId?: string;
  evidenceIds?: string[];
  target?: 'main' | 'inspector';
  heading?: string;
  snapshots?: ContextSnapshot[];
  showNote?: boolean;
}) {
  const { data, research, actions } = useWorkspace();
  const ids =
    evidenceIds ??
    Object.values(data.evidence)
      .filter(
        (item) =>
          !item.contextOnly &&
          (!documentId || item.documentId === documentId) &&
          (!research || (research.documentIds.includes(item.documentId) && (!item.researchId || item.researchId === research.id))),
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
      {heading && <div className="evidence-list-heading">
        <span className="section-heading">{heading}</span>
        <span className="muted">{ids.length} 条</span>
      </div>}
      {!ids.length && (
        <div className="empty-state compact">
          <Quote size={28} />
          <h3>让观点有据可查</h3>
          <p>在 PDF 中选中原文，点击“摘录”或按 H，摘录会显示在这里。</p>
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
        const fragments = evidenceGroup(data, item);
        return (
          <article className="evidence-entry" key={id} data-evidence-id={id}>
            <div className="evidence-source-label">
              <BookOpen size={13} />
              <span>
                {pageRangeLabel(fragments.map(fragment => fragment.pageIndex))}
                {fragments.length > 1 ? ` · 当前片段第 ${item.pageIndex + 1} 页` : ''}
                {item.printedPage ? ` · 印刷页 ${item.printedPage}` : ''}
                {!item.researchId && ' · 来源研究未记录'}
                {item.researchId && item.researchId !== research?.id && ` · ${data.researches[item.researchId]?.title ?? '其他研究'}`}
              </span>
            </div>
            {item.kind === 'region' && item.region && <>
              <p className="evidence-region-label">区域证据 · {item.region.width} × {item.region.height} 像素</p>
              <RegionPreview region={item.region} />
            </>}
            {item.quote && <blockquote>{item.quote}</blockquote>}
            {Object.values(data.cards).filter(card => (!research || research.cardIds.includes(card.id)) && card.evidenceIds.includes(id)).map(card => <button className="text-button evidence-card-link" key={card.id} onClick={() => execute(() => actions.openResource({ kind: 'card', id: card.id }, { scope: data.scope, target: 'inspector' }))}>→ 卡片「{card.title}」</button>)}
            {showNote && <label className="excerpt-note">随手记<textarea aria-label={`摘录随手记：${id}`} value={item.note ?? ''} placeholder="记下这段与你的问题有什么关系…" onChange={event => execute(() => actions.updateData(next => { next.evidence[id].note = event.target.value; }))} /></label>}
            {item.dismissed && <p className="muted">已标为不需要 <button className="text-button" onClick={() => execute(() => actions.updateData(next => { next.evidence[id].dismissed = false; }))}>恢复摘录</button></p>}

            <button
              className="evidence-document-link"
              onClick={() => open(target)}
            >
              {doc.title}
              <ExternalLink size={12} />
            </button>
            <div className="evidence-actions">
              {fragments.length > 1 && fragments.map(fragment => <button key={fragment.id} type="button" className="text-button" onClick={() => execute(() => actions.openResource({ kind: 'document', id: doc.id }, { scope: data.scope, target, anchor: { evidenceId: fragment.id, pageIndex: fragment.pageIndex } }))}>回查第 {fragment.pageIndex + 1} 页</button>)}
              <button className="text-button" onClick={() => execute(() => actions.setExcerptMarked(id, !!item.annotationHidden))}>
                {item.annotationHidden ? '恢复标记' : '移除标记'}
              </button>
              <button className="text-button" onClick={() => open('main')}>
                定位原文
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
                写成卡片
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
