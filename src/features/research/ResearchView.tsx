import {
  ArrowRight,
  BookOpen,
  FileText,
  Network,
  Plus,
  Quote,
  Target,
} from 'lucide-react';
import { useWorkspace } from '../../services/workspace';

export function ResearchView({ researchId }: { researchId: string }) {
  const { data, actions } = useWorkspace();
  const research = data.researches[researchId];
  if (!research)
    return (
      <div className="empty-state">研究已缺失，请从研究空间重新打开。</div>
    );
  const documents = research.documentIds
    .map((id) => data.documents[id])
    .filter(Boolean);
  const boards = Object.values(data.boards).filter(
    (item) => item.researchId === researchId,
  );
  const drafts = Object.values(data.drafts).filter(
    (item) => item.researchId === researchId,
  );
  const scope = { kind: 'research' as const, researchId };
  const evidence = Object.values(data.evidence).filter((item) =>
    research.documentIds.includes(item.documentId),
  );
  const readCount = documents.filter(
    (item) => item.readingStatus === 'read',
  ).length;
  return (
    <div className="overview page-content">
      <div className="eyebrow">
        <span className="status-dot" /> RESEARCH WORKSPACE
      </div>
      <h1>{research.title}</h1>
      <p className="page-lead">让每一个观点，都有迹可循。</p>
      <section className="question-box">
        <Target size={19} />
        <div>
          <span className="section-heading">核心研究问题</span>
          <textarea
            aria-label="核心研究问题"
            value={research.question}
            onChange={(event) =>
              actions.updateData((data) => {
                data.researches[researchId].question = event.target.value;
              })
            }
          />
        </div>
      </section>
      <div className="stat-grid">
        <div>
          <BookOpen size={18} />
          <strong>{documents.length}</strong>
          <span>篇论文</span>
        </div>
        <div>
          <Quote size={18} />
          <strong>{evidence.length}</strong>
          <span>条原文证据</span>
        </div>
        <div>
          <FileText size={18} />
          <strong>{research.cardIds.length}</strong>
          <span>张观点卡片</span>
        </div>
      </div>
      <div className="section-title">
        <h2>研究材料</h2>
        <span className="muted">
          {readCount} / {documents.length} 已读
        </span>
      </div>
      {documents.length ? (
        <div className="paper-list">
          {documents.map((doc, index) => (
            <button
              className="paper-row"
              key={doc.id}
              onClick={() =>
                actions.openResource(
                  { kind: 'document', id: doc.id },
                  { scope, target: 'main' },
                )
              }
            >
              <span className={`paper-icon tint-${index % 3}`}>
                <FileText size={21} />
              </span>
              <span className="paper-details">
                <strong>{doc.title}</strong>
                <small>
                  {doc.authors} · {doc.year} · {doc.pageCount} 页
                </small>
              </span>
              <span
                className={`badge ${doc.readingStatus === 'reading' ? 'teal' : ''}`}
              >
                {doc.readingStatus === 'read'
                  ? '已读'
                  : doc.readingStatus === 'reading'
                    ? '在读'
                    : '待读'}
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          <BookOpen />
          <h3>从第一篇论文开始</h3>
          <p>导入 PDF，留下证据，再形成自己的观点。</p>
          <button
            className="button"
            onClick={() => actions.openCollection('documents')}
          >
            前往论文库
          </button>
        </div>
      )}
      <div className="section-title">
        <h2>思考与产出</h2>
      </div>
      <div className="workspace-shortcuts">
        {boards.map((board) => (
          <button
            key={board.id}
            className="workspace-shortcut"
            onClick={() =>
              actions.openResource(
                { kind: 'board', id: board.id },
                { scope, target: 'main' },
              )
            }
          >
            <span className="shortcut-symbol green">
              <Network size={23} />
            </span>
            <strong>{board.title}</strong>
            <small>组织卡片，连接证据与论证</small>
            <ArrowRight size={16} />
          </button>
        ))}
        {drafts.map((draft) => (
          <button
            key={draft.id}
            className="workspace-shortcut"
            onClick={() =>
              actions.openResource(
                { kind: 'draft', id: draft.id },
                { scope, target: 'main' },
              )
            }
          >
            <span className="shortcut-symbol purple">
              <FileText size={23} />
            </span>
            <strong>{draft.title}</strong>
            <small>写下结论，导出带来源的笔记</small>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
      <button
        className="text-button add-board"
        onClick={() =>
          actions.updateData((data) => {
            const id = `board-${crypto.randomUUID()}`;
            data.boards[id] = {
              id,
              researchId,
              title: `研究白板 ${boards.length + 1}`,
            };
          })
        }
      >
        <Plus size={14} />
        新建白板
      </button>
      <div className="overview-note">
        <span>从材料到理解</span>
        <p>阅读原文 → 留下证据 → 形成观点 → 组织论证 → 写出结论</p>
      </div>
    </div>
  );
}
