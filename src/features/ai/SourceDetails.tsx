import { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import type {
  AIHistoryTurn,
  ContextSnapshot,
  WorkspaceData,
} from '../../domain/types';
import { getAsset } from '../../data/storage';
import { useWorkspace } from '../../services/workspace';

export function originalAnswerContext(turn: AIHistoryTurn): ContextSnapshot[] {
  return turn.evidenceIds.flatMap((id) =>
    turn.context.filter((item) => item.evidenceId === id),
  );
}

export function hasOriginalDocument(
  data: WorkspaceData,
  snapshot?: ContextSnapshot,
): boolean {
  return (
    !!snapshot?.documentHash &&
    data.documents[snapshot.documentId]?.hash === snapshot.documentHash
  );
}

export function RegionPreview({ assetId }: { assetId: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let cancelled = false,
      objectUrl = '';
    void getAsset(assetId)
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [assetId]);
  return url ? (
    <img className="ai-region-preview" src={url} alt="本轮发送的 PDF 区域" />
  ) : (
    <p className="ai-footnote">区域图片暂不可用，仍保留页码与区域位置。</p>
  );
}

export function ContextDetails({ items }: { items: ContextSnapshot[] }) {
  const { data, actions } = useWorkspace();
  return (
    <div className="ai-context-details">
      {items.length ? (
        items.map((item, index) => {
          const available = hasOriginalDocument(data, item);
          const evidence = data.evidence[item.evidenceId];
          const anchorMatches =
            evidence?.documentId === item.documentId &&
            evidence.pageIndex === item.pageIndex &&
            evidence.quote === item.quote;
          return (
            <div className="ai-context-entry" key={item.evidenceId}>
              <strong>
                [{index + 1}] {item.title} · PDF 第 {item.pageIndex + 1} 页
              </strong>
              {item.kind === 'region' && item.region && (
                <RegionPreview assetId={item.region.assetId} />
              )}
              <blockquote>{item.quote}</blockquote>
              <button
                className="text-button"
                disabled={!available}
                onClick={() => {
                  if (!available) return;
                  try {
                    actions.openResource(
                      { kind: 'document', id: item.documentId },
                      {
                        scope: data.scope,
                        target: 'main',
                        anchor: {
                          evidenceId: anchorMatches
                            ? item.evidenceId
                            : undefined,
                          pageIndex: item.pageIndex,
                        },
                      },
                    );
                  } catch (caught) {
                    actions.notice(
                      caught instanceof Error ? caught.message : '原文暂不可用',
                    );
                  }
                }}
              >
                <BookOpen size={13} />
                查看原文
              </button>
              {!available && (
                <p className="ai-info">
                  原文件缺失或版本已变化，已保留当时摘录和 PDF 页码；恢复相同
                  hash 的原文件后可回查。
                </p>
              )}
              <small className="ai-hash">
                来源 hash：{item.documentHash || '旧记录未保存'}
              </small>
            </div>
          );
        })
      ) : (
        <p className="ai-footnote">本次没有直接论文材料。</p>
      )}
    </div>
  );
}
