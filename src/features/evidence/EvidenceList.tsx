import { BookOpen, ExternalLink, Layers, Quote, Sparkles } from 'lucide-react';
import { useWorkspace } from '../../services/workspace';
import './evidence.css';

export function EvidenceList({
  documentId,
  evidenceIds,
  target = 'inspector',
}: {
  documentId?: string;
  evidenceIds?: string[];
  target?: 'main' | 'inspector';
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
        <span className="section-heading">原文证据</span>
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
        const valid =
          item &&
          doc &&
          Number.isInteger(item.pageIndex) &&
          item.pageIndex >= 0 &&
          item.pageIndex < doc.pageCount &&
          !!item.quote.trim();
        if (!valid)
          return (
            <div className="evidence-missing" role="alert" key={id}>
              来源引用已缺失或 PDF 页码无效。请恢复原论文与证据后重新核查，引用
              ID：{id}。
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
            <blockquote>{item.quote}</blockquote>
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
                    const cardId = actions.createCard(
                      [id],
                      item.quote.length > 26
                        ? `${item.quote.slice(0, 26)}…`
                        : item.quote,
                    );
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
            </div>
          </article>
        );
      })}
    </div>
  );
}
