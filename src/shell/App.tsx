import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Home,
  Layers,
  Menu,
  Network,
  PanelLeftClose,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';
import type { PanelMode, ReaderTarget, ResearchViewId, ResourceRef } from '../domain/types';
import {
  resourceExists,
  resourceTitle,
  scopeKey,
  useWorkspace,
  workspace,
} from '../services/workspace';
import { ResearchView } from '../features/research/ResearchView';
import { ResearchDirectory } from '../features/research/ResearchDirectory';
import { CreateResearchDialog } from '../features/research/CreateResearchDialog';
import { PendingResearchRecovery } from '../features/research/PendingResearchRecovery';
import { ProjectFileStatus } from '../features/research/ProjectFileStatus';
import { LibraryView } from '../features/library/LibraryView';
import { SourcesView } from '../features/library/SourcesView';
import { DocumentDetail } from '../features/library/DocumentDetail';
import { SourcePreview } from '../features/library/SourcePreview';
import { AddSourceDialog, SourceDropZone } from '../features/library/AddSourceDialog';
import { ResourceListView } from '../features/research/ResourceListView';
import { CardsView } from '../features/cards/CardsView';
import { ExcerptsView } from '../features/evidence/ExcerptsView';
import { FindEvidencePanel, TraceChain } from '../features/evidence/KnowledgePanel';
import { hasFullText } from '../domain/knowledge';
import { PdfReader } from '../features/reader/PdfReader';
import { ImportPDFButton } from '../features/reader/ImportPDFButton';
import { EvidenceList } from '../features/evidence/EvidenceList';
import { CardEditor } from '../features/cards/CardEditor';
import { BoardView } from '../features/board/BoardView';
import { WritingView } from '../features/writing/WritingView';
import { AIPanel } from '../features/ai/AIPanel';
import { getAIConfig } from '../services/ai';
import { ResourceTabs } from './ResourceTabs';
import { WorkspaceSplit } from './WorkspaceSplit';
import { DesktopWindowControls } from './DesktopWindowControls';
import { BackupControls } from '../features/settings/BackupControls';

const researchViews: { id: ResearchViewId; name: string; icon: typeof Home; group?: string }[] = [
  { id: 'home', name: '研究主页', icon: Home },
  { id: 'sources', name: '资料', icon: BookOpen, group: '阅读' },
  { id: 'excerpts', name: '摘录', icon: FileText },
  { id: 'cards', name: '卡片', icon: Layers, group: '思考与写作' },
  { id: 'boards', name: '白板', icon: Network },
  { id: 'drafts', name: '文稿', icon: FileText },
];
const modes: { id: PanelMode; name: string }[] = [
  { id: 'excerpts', name: '摘录' }, { id: 'cards', name: '卡片' }, { id: 'ai', name: 'AI' },
];
function ModelConnection() {
  const [message, setMessage] = useState('正在检查模型连接…');
  useEffect(() => {
    let cancelled = false;
    void getAIConfig().then(config => {
      if (!cancelled) setMessage(config.configured ? `模型连接：${config.provider} · ${config.model}，${config.images ? '已启用文字与区域图片' : '已启用文字'}。` : '模型连接：尚未配置。可在 AI 面板明确选择演示模式。');
    }).catch(() => { if (!cancelled) setMessage('AI 本地服务未启动。请按 README 启动后重试。'); });
    return () => { cancelled = true; };
  }, []);
  return <><p>{message}</p>{window.papertrailDesktop && <button className="button" onClick={() => void window.papertrailDesktop?.openAISettings()}>配置模型连接</button>}</>;
}
function ResourceIcon({ kind, size = 16 }: { kind: string; size?: number }) {
  const Icon =
    kind === 'document'
      ? BookOpen
      : kind === 'board' || kind === 'research'
        ? Network
        : kind === 'card'
          ? Layers
          : FileText;
  return <Icon size={size} />;
}

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="empty-state" role="alert">
        <h3>此视图暂时无法打开</h3>
        <p>{this.state.error}</p>
        <button
          className="button"
          onClick={() => this.setState({ error: undefined })}
        >
          重试视图
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}

export function App() {
  const {
    data,
    session,
    research,
    loaded,
    loadError,
    saveStatus,
    saveError,
    notice,
    actions,
  } = useWorkspace();
  const [narrow, setNarrow] = useState(window.innerWidth <= 1024);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'search' | 'settings' | null>(
    null,
  );
  useEffect(() => window.papertrailDesktop?.onOpenStorage(() => setDialog('settings')), []);
  const [search, setSearch] = useState('');
  const lastFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const active = session.active;
  const activeTitle = session.sourcePreview ? session.sourcePreview.candidate.title : active.kind === 'researchView' ? researchViews.find(item => item.id === active.id)?.name ?? '研究主页' : active.kind === 'collection' ? '资料库' : resourceTitle(data, active);
  const navigationTrigger = useRef<HTMLElement | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  useEffect(() => {
    void workspace.load();
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1024px)');
    const change = () => {
      setNarrow(media.matches);
      setNavigationOpen(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        showDialog('search');
      }
      if (event.key === 'Escape') {
        if (dialog) closeDialog();
        else if (navigationOpen) closeNavigation();
        else actions.setPanel(session.panel.mode, false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dialog, navigationOpen, session.panel.mode]);
  useEffect(() => {
    if (dialog)
      dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [dialog]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => actions.notice(), 3500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => { if (navigationOpen) sidebarRef.current?.querySelector<HTMLElement>('select,button')?.focus(); }, [navigationOpen]);
  function closeNavigation() { setNavigationOpen(false); navigationTrigger.current?.focus(); }
  function navigate(view: ResearchViewId) { if (research) actions.openResearchView(research.id, view); if (narrow) closeNavigation(); }
  function showDialog(kind: typeof dialog) {
    lastFocus.current = document.activeElement as HTMLElement;
    setDialog(kind);
  }
  function closeDialog() {
    setDialog(null);
    lastFocus.current?.focus();
  }
  function open(ref: ResourceRef, target: ReaderTarget = 'main') {
    actions.openResource(ref, { scope: data.scope, target });
  }
  function resourceView(ref: ResourceRef, target: ReaderTarget) {
    if (!resourceExists(data, ref))
      return (
        <div className="empty-state">
          <h3>资源已缺失</h3>
          <p>原文件或来源不在本地数据中，请重新导入或从资料库打开。</p>
        </div>
      );
    if (ref.kind === 'document' && (!hasFullText(data.documents[ref.id]) || target === 'main' && session.documentInfoId === ref.id)) return <DocumentDetail key={ref.id} documentId={ref.id} />;
    if (ref.kind === 'document')
      return (
        <PdfReader
          key={`${target}:${ref.id}`}
          documentId={ref.id}
          target={target}
          anchor={target === 'main' ? session.anchor : target === 'main-secondary' ? session.mainSplit?.anchor : session.panel.anchor}
        />
      );
    if (ref.kind === 'card') return <CardEditor cardId={ref.id} />;
    if (ref.kind === 'board') return <BoardView boardId={ref.id} />;
    if (ref.kind === 'draft') return <WritingView draftId={ref.id} />;
    return <ResearchView researchId={ref.id} />;
  }
  const evidenceIds =
    active.kind === 'card' ? data.cards[active.id]?.evidenceIds : undefined;
  const documentId = active.kind === 'document' ? active.id : undefined;
  const allRefs: ResourceRef[] = [
    ...Object.keys(data.documents).map((id) => ({
      kind: 'document' as const,
      id,
    })),
    ...Object.keys(data.cards).map((id) => ({ kind: 'card' as const, id })),
    ...Object.keys(data.researches).map((id) => ({
      kind: 'research' as const,
      id,
    })),
    ...Object.keys(data.drafts).map((id) => ({ kind: 'draft' as const, id })),
  ];
  if (!loaded)
    return (
      <div className="loading-screen">
        <BookOpen />
        <p>正在恢复研究工作台…</p>
      </div>
    );
  if (loadError)
    return (
      <div className="loading-screen" role="alert">
        <BookOpen />
        <h2>本地资料暂时无法加载</h2>
        <p>{loadError}</p>
        <button className="button" onClick={() => void actions.load()}>
          重试加载
        </button>
      </div>
    );
  return (
    <div
      className={`app-shell ${data.sidebarCollapsed ? 'sidebar-collapsed' : ''} ${session.panel.open ? 'panel-open' : ''} ${navigationOpen ? 'navigation-open' : ''} ${session.panel.open && session.panel.mode === 'ai' ? 'ai-panel-open' : ''}`}
      style={{ '--panel-width': `${data.panelWidth}px` } as React.CSSProperties}
    >
      <PendingResearchRecovery key={workspace.getGeneration()} />
      {narrow && navigationOpen && (
        <button
          className="navigation-backdrop"
          aria-label="关闭导航抽屉"
          onClick={closeNavigation}
        />
      )}
      <aside className="sidebar" ref={sidebarRef} aria-label="左侧导航" role={narrow && navigationOpen ? 'dialog' : undefined} aria-modal={narrow && navigationOpen || undefined} onKeyDown={event => {
        if (!narrow || !navigationOpen || event.key !== 'Tab') return;
        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select,input'));
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className="brand">
          <span className="brand-mark">
            <BookOpen size={20} />
          </span>
          <strong>
            Papertrail<span>研究有迹可循</span>
          </strong>
          <button
            className="icon-button"
            aria-label="收起左栏"
            onClick={() => {
              if (narrow) closeNavigation();
              else
                actions.updateData((data) => {
                  data.sidebarCollapsed = true;
                });
            }}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <div className="research-project-row">
          <label className="research-switcher" title={research?.title ?? '切换研究'}><span className="research-dot" /><select aria-label="切换研究" value={research?.id ?? ''} onChange={event => { actions.switchResearch(event.target.value); if (narrow) closeNavigation(); }}><option value="" disabled>全局资料浏览</option>{Object.values(data.researches).map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><ChevronDown size={13} /></label>
          {research && <ResearchDirectory researchId={research.id} settings />}
        </div>
        <div className="sidebar-actions"><button className="new-research" onClick={() => showDialog('new')}><Plus size={16} />新建研究</button><button className="icon-button search-trigger" aria-label="全局搜索" onClick={() => showDialog('search')}><Search size={18} /></button></div>
        <nav className="research-nav" aria-label="研究内导航">
          {research && researchViews.map(({ id, name, icon: Icon, group }) => <div key={id}>
            {group && <div className="sidebar-section-label">{group}</div>}
            <button className={`nav-item ${active.kind === 'researchView' && active.id === id ? 'active' : ''}`} onClick={() => navigate(id)}><Icon size={17} />{name}</button>
            {(id === 'boards' || id === 'drafts') && Object.values(id === 'boards' ? data.boards : data.drafts).filter(item => item.researchId === research.id).map(item => <button key={item.id} className={`nav-item nested-nav ${active.id === item.id ? 'active' : ''}`} onClick={() => { open({ kind: id === 'boards' ? 'board' : 'draft', id: item.id }); if (narrow) closeNavigation(); }}><span>{item.title}</span></button>)}
          </div>)}
        </nav>
        <div className="sidebar-bottom-nav"><button className={`nav-item ${data.scope.kind === 'library' ? 'active' : ''}`} onClick={() => { actions.openCollection('documents'); if (narrow) closeNavigation(); }}><BookOpen size={17} />资料库</button><button className="nav-item" onClick={() => showDialog('settings')}><Settings2 size={17} />设置</button></div>
        <div className="sidebar-footer">
          <span
            className={`status-dot ${saveStatus === 'error' ? 'error' : ''}`}
          />
          <span>
            {saveStatus === 'saved'
              ? '已保存到本地'
              : saveStatus === 'saving'
                ? '正在保存…'
                : saveStatus === 'error'
                  ? '保存失败'
                  : '有未保存修改'}
          </span>
          <button
            className="icon-button"
            aria-label="存储与设置"
            onClick={() => showDialog('settings')}
          >
            <Settings2 size={16} />
          </button>
        </div>
        {research?.directory && <ProjectFileStatus key={`${research.id}:${actions.getGeneration()}`} researchId={research.id} compact />}
      </aside>
      <div className="main-column">
        <header className="workspace-header">
          <div className="breadcrumb">
            {(data.sidebarCollapsed || narrow) && (
              <button
                className="icon-button"
                aria-label="展开左栏"
                onClick={() => {
                  if (narrow) { navigationTrigger.current = document.activeElement as HTMLElement; setNavigationOpen(true); }
                  else
                    actions.updateData((data) => {
                      data.sidebarCollapsed = false;
                    });
                }}
              >
                <Menu size={18} />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="主区返回"
              disabled={!session.sourcePreview && !session.history.length}
              onClick={() => actions.back('main')}
            >
              <ArrowLeft size={17} />
            </button>
            <span>{research ? research.title : '全局资料库'}</span>
            <ChevronRight size={13} />
            <strong>{activeTitle}</strong>
          </div>
          <div className="header-actions">
            <DesktopWindowControls />
            {!session.sourcePreview && active.kind === 'document' && hasFullText(data.documents[active.id]) && <button className="text-button" onClick={() => actions.updateData(next => { next.sessions[scopeKey(next.scope)].documentInfoId = session.documentInfoId === active.id ? undefined : active.id; })}>{session.documentInfoId === active.id ? '阅读全文' : '文献信息'}</button>}
            <span
              className="save-indicator"
              data-testid="save-status"
              data-status={saveStatus}
            >
              {saveStatus === 'saved' ? (
                <>
                  <Check size={12} />
                  已保存
                </>
              ) : saveStatus === 'saving' ? (
                '保存中…'
              ) : saveStatus === 'error' ? (
                '保存失败'
              ) : (
                '未保存'
              )}
            </span>
            {research && <ImportPDFButton compact />}
            <button
              className="icon-button"
              aria-label={session.panel.open ? '收起右侧面板' : '展开右侧面板'}
              onClick={() =>
                actions.setPanel(session.panel.mode, !session.panel.open)
              }
            >
              {session.panel.open ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </button>
          </div>
        </header>
        {saveStatus === 'error' && (
          <div className="save-error" role="alert">
            <span>{saveError}</span>
            <button className="button" onClick={() => actions.retrySave()}>
              重试保存
            </button>
          </div>
        )}
        <ResourceTabs preview={session.sourcePreview ? { title: session.sourcePreview.candidate.title, onClose: () => actions.closeSourcePreview() } : undefined} leading={{ title: data.scope.kind === 'research' ? researchViews.find(item => item.id === (session.researchView ?? 'home'))?.name ?? '研究主页' : '资料库', selected: !session.sourcePreview && (active.kind === 'researchView' || active.kind === 'collection'), onOpen: () => { if (data.scope.kind === 'research') actions.openResearchView(data.scope.researchId, session.researchView ?? 'home'); else actions.openCollection('documents'); } }} items={session.openItems} active={session.active} pinnedIds={session.pinnedIds}
          title={ref => resourceTitle(data, ref)} onOpen={ref => open(ref)} onOpenSecondary={ref => open(ref, 'main-secondary')}
          onClose={ref => actions.closeResource(ref)} onPin={ref => actions.pinResource(ref)}
          onMove={(from, to) => actions.updateData(next => {
            const items = next.sessions[scopeKey(next.scope)].openItems;
            if (from < 0 || to < 0 || from >= items.length || to >= items.length) return;
            items.splice(to, 0, items.splice(from, 1)[0]);
          })} />
        <main aria-label="主工作区" className="main-workspace">
          <ErrorBoundary key={`${scopeKey(data.scope)}:${session.sourcePreview?.candidate.url ?? `${active.kind}:${active.id}`}`}>
            {session.sourcePreview ? <SourcePreview candidate={session.sourcePreview.candidate} discovery={session.sourcePreview.discovery} scope={data.scope} /> : active.kind === 'collection' ? <LibraryView collection={active.id} /> : active.kind === 'researchView' && research ? (
              active.id === 'home' ? <ResearchView researchId={research.id} /> : active.id === 'sources' ? <SourcesView researchId={research.id} /> : active.id === 'excerpts' ? <ExcerptsView researchId={research.id} /> : active.id === 'cards' ? <CardsView researchId={research.id} /> : <ResourceListView researchId={research.id} kind={active.id === 'boards' ? 'board' : 'draft'} />
            ) : active.kind !== 'researchView' ? (
              <WorkspaceSplit primary={active} renderResource={resourceView} />
            ) : <div className="empty-state">请先选择研究。</div>}
          </ErrorBoundary>
        </main>
        <footer className="workspace-footer">
          <span>本地工作空间</span>
          <span>
            {research
              ? `${research.documentIds.length} 篇论文 · ${research.cardIds.length} 张卡片`
              : '全局资料独立会话'}
            <span className="footer-key">⌘ K 搜索</span>
          </span>
        </footer>
      </div>
      {session.panel.open && (
        <aside className="inspector" aria-label="参考面板">
          <div
            className="resize-handle"
            role="separator"
            aria-label="调整右侧宽度"
            aria-orientation="vertical"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                actions.updateData((data) => {
                  data.panelWidth = Math.max(
                    session.panel.mode === 'ai' && window.innerWidth >= 1024 ? 420 : 320,
                    Math.min(
                      520,
                      Math.max(data.panelWidth, session.panel.mode === 'ai' && window.innerWidth >= 1024 ? 420 : 320) + (event.key === 'ArrowLeft' ? 20 : -20),
                    ),
                  );
                });
            }}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (event.buttons === 1)
                actions.updateData((data) => {
                  data.panelWidth = Math.max(
                    session.panel.mode === 'ai' && window.innerWidth >= 1024 ? 420 : 320,
                    Math.min(520, window.innerWidth - event.clientX),
                  );
                });
            }}
          />
          <div className="inspector-header">
            <strong>
              <Layers size={15} />
              研究参考
            </strong>
            <div className="button-row">
              <button
                className="icon-button"
                aria-label="右侧返回"
                disabled={!session.panel.history.length}
                onClick={() => actions.back('inspector')}
              >
                <ArrowLeft size={15} />
              </button>
              <button
                className={`icon-button ${session.panel.pinned ? 'pinned' : ''}`}
                aria-label="固定右侧参考"
                onClick={() =>
                  actions.updateData((data) => {
                    const panel = data.sessions[scopeKey(data.scope)].panel;
                    panel.pinned = !panel.pinned;
                  })
                }
              >
                <Pin size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="关闭右侧面板"
                onClick={() => actions.setPanel(session.panel.mode, false)}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="panel-tabs" role="tablist" aria-label="参考面板模式">
            {modes.map((mode) => (
              <button
                key={mode.id}
                role="tab"
                aria-selected={session.panel.mode === mode.id}
                onClick={() => actions.setPanel(mode.id)}
              >
                {mode.id === 'ai' && <Sparkles size={13} />} {mode.name}
              </button>
            ))}
          </div>
          <div className={`inspector-content mode-${session.panel.mode}`}>
            <ErrorBoundary
              key={`${scopeKey(data.scope)}:${session.panel.mode}:${session.panel.ref?.id}:${session.panel.findEvidenceFor}:${session.panel.citation?.evidenceId}`}
            >
              {session.panel.mode === 'ai' ? (
                <AIPanel />
              ) : session.panel.mode === 'excerpts' ? (
                <EvidenceList
                  documentId={documentId}
                  evidenceIds={evidenceIds}
                  target="inspector"
                  heading={documentId ? "本篇摘录" : "研究摘录"}
                />
              ) : session.panel.findEvidenceFor ? <FindEvidencePanel cardId={session.panel.findEvidenceFor} /> : session.panel.citation ? <TraceChain {...session.panel.citation} /> : session.panel.ref ? (
                <>
                  <div className="reference-title">
                    <span>{resourceTitle(data, session.panel.ref)}</span>
                    <button
                      className="text-button"
                      onClick={() =>
                        actions.openResource(session.panel.ref!, {
                          scope: data.scope,
                          target: 'main',
                          anchor:
                            session.panel.anchor ??
                            (session.panel.ref?.kind === 'document'
                              ? {
                                  pageIndex:
                                    session.readers[
                                      `inspector:${session.panel.ref.id}`
                                    ]?.pageIndex ?? 0,
                                }
                              : undefined),
                        })
                      }
                    >
                      在主区打开 ↗
                    </button>
                  </div>
                  {resourceView(session.panel.ref, 'inspector')}
                </>
              ) : (
                <div className="reference-list">
                  <div className="panel-intro">
                    <span className="section-heading">观点与原文</span>
                    <p>把理解留在卡片里，让来源留在手边。</p>
                  </div>
                  {(research ? research.cardIds : Object.keys(data.cards)).map(
                    (id) => (
                      <button
                        className="reference-card"
                        key={id}
                        onClick={() => open({ kind: 'card', id }, 'inspector')}
                      >
                        <span className="reference-card-label">
                          观点卡片{' '}
                          {data.cards[id]?.needsReview && <span>· 待核查</span>}
                        </span>
                        <strong>{data.cards[id]?.title ?? '卡片已缺失'}</strong>
                        <p>{data.cards[id]?.body.slice(0, 90)}</p>
                        <small>
                          {data.cards[id]?.evidenceIds.length ?? 0} 条来源{' '}
                          <ArrowLeft size={11} />
                        </small>
                      </button>
                    ),
                  )}
                  {!research?.cardIds.length && research && (
                    <div className="empty-state compact">
                      <Layers />
                      <p>阅读原文后，创建你的第一张观点卡片。</p>
                    </div>
                  )}
                </div>
              )}
            </ErrorBoundary>
          </div>
        </aside>
      )}
      <AddSourceDialog /><SourceDropZone />
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => actions.notice()}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {dialog === 'new' && <CreateResearchDialog onClose={closeDialog} />}
      {dialog && dialog !== 'new' && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeDialog();
          }}
        >
          <div
            className="modal"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === 'search'
                  ? '全局搜索'
                  : '存储与设置'
            }
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              const elements = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),input,textarea,select',
                ),
              );
              const first = elements[0],
                last = elements.at(-1);
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <div className="modal-heading">
              <h2>
                {dialog === 'search'
                    ? '搜索你的资料'
                    : '本地存储与连接'}
              </h2>
              <button
                className="icon-button"
                aria-label="关闭弹层"
                onClick={closeDialog}
              >
                <X size={18} />
              </button>
            </div>
            {dialog === 'search' ? (
              <>
                <label className="search-input">
                  <Search size={18} />
                  <input
                    aria-label="搜索全部资料"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="论文、观点卡片、研究问题…"
                  />
                </label>
                <div className="search-results">
                  {allRefs
                    .filter((ref) =>
                      resourceTitle(data, ref)
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .map((ref) => (
                      <button
                        key={`${ref.kind}:${ref.id}`}
                        onClick={() => {
                          const researchId =
                            ref.kind === 'research'
                              ? ref.id
                              : ref.kind === 'draft'
                                ? data.drafts[ref.id].researchId
                                : undefined;
                          actions.openResource(ref, {
                            scope: researchId
                              ? { kind: 'research', researchId }
                              : { kind: 'library' },
                            target: 'main',
                          });
                          closeDialog();
                        }}
                      >
                        <ResourceIcon kind={ref.kind} />
                        {resourceTitle(data, ref)}
                        <ChevronRight size={14} />
                      </button>
                    ))}
                </div>
              </>
            ) : (
              <div className="settings-content">
                <p>
                  <span className="status-dot" /> PDF
                  与研究数据保存在{window.papertrailDesktop ? '此应用的本地数据目录中。' : '此浏览器的本地存储中。'}
                </p>
                <p>{window.papertrailDesktop ? '资料保存在此电脑。换电脑前请导出完整备份。' : '换浏览器或清除站点数据将移除本地资料。'}</p>
                <ModelConnection />
                <BackupControls />
                <p>
                  保存状态：{saveStatus}
                  {saveError && ` · ${saveError}`}
                </p>
                <button className="button" onClick={() => actions.retrySave()}>
                  重试本地保存
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
