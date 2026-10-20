import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { getAsset } from '../../src/data/storage';
import { buildResearchFiles, researchFileData } from '../../src/services/project-files';
import { captureBoardContext, recordBoardChanges } from '../../src/domain/board-history';
const digest = (bytes: ArrayBuffer | Uint8Array) => createHash('sha256').update(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).digest('hex');
vi.mock('../../src/data/storage', () => ({ getAsset: vi.fn(), contentHash: async (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex') }));
const pdf = new Blob(['%PDF-1.4\nsynthetic fixture\n%%EOF'], { type: 'application/pdf' });
async function drawingAsset(source: string, image = false) {
  const blob = new Blob([JSON.stringify({ type: 'excalidraw', version: 2, source, elements: [],
    appState: { viewBackgroundColor: '#fff', scrollX: 0, scrollY: 0, zoom: { value: 1 } },
    files: image ? { 'image-a': { id: 'image-a', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==' } } : {},
  })], { type: 'application/vnd.excalidraw+json' });
  const hash = digest(await blob.arrayBuffer()), id = `drawing-${hash}`;
  return { ref: { assetId: id, hash }, blob };
}

beforeEach(() => { vi.mocked(getAsset).mockReset().mockResolvedValue(pdf); });
describe('研究目录的完整可读文件集', () => {
  it('导出本研究当前、历史及请求场景为独立excalidraw文件，保留图片和索引且隔离其他研究', async () => {
    const seed = createSeed(), historical = await drawingAsset('historical', true), current = await drawingAsset('current'), requested = await drawingAsset('requested'), privateScene = await drawingAsset('研究B私有绘图');
    Object.values(seed.documents).forEach(doc => { if (doc.assetId) doc.hash = digest(new TextEncoder().encode('%PDF-1.4\nsynthetic fixture\n%%EOF')); });
    seed.boards['board-a'].drawing = historical.ref;
    const before = structuredClone(seed);
    seed.boards['board-a'].drawing = current.ref;
    seed.boards['board-b'].drawing = privateScene.ref;
    recordBoardChanges(before, seed);
    const context = captureBoardContext(seed, 'research-a', 'board-a', 'board'); context.snapshot.board.drawing = requested.ref;
    seed.requests['drawing-request'] = { id: 'drawing-request', researchId: 'research-a', conversationId: 'conversation-research-a', prompt: '', body: '', context: [], history: [], evidenceIds: [], createdAt: '', status: 'done', boardContext: context };
    const scenes = [historical, current, requested, privateScene];
    vi.mocked(getAsset).mockImplementation(async id => scenes.find(scene => scene.ref.assetId === id)?.blob ?? pdf);
    const { files } = await buildResearchFiles(seed, 'research-a'), map = Object.fromEntries(files.map(file => [file.path, file]));
    const saved = JSON.parse(map['research.json'].content);
    for (const scene of [historical, current, requested]) {
      const path = `drawings/${scene.ref.assetId}.excalidraw`;
      expect(Buffer.from(map[path].content, 'base64').toString()).toBe(await scene.blob.text());
      expect(saved.assets[scene.ref.assetId].path).toBe(path);
    }
    expect(files.filter(file => file.path.startsWith('drawings/'))).toHaveLength(3);
    expect(JSON.stringify(files)).not.toContain(privateScene.ref.assetId);
    expect(JSON.parse(map['boards/board-a.json'].content)).toMatchObject({ board: { drawing: current.ref }, drawingPath: `../drawings/${current.ref.assetId}.excalidraw` });
    vi.mocked(getAsset).mockClear();
    vi.mocked(getAsset).mockImplementation(async id => id === current.ref.assetId ? undefined : scenes.find(scene => scene.ref.assetId === id)?.blob ?? pdf);
    await expect(buildResearchFiles(seed, 'research-a')).rejects.toThrow(/缺失/);
  });

  it('绘图缓存不能掩盖损坏资产，伪造但hash一致的非绘图JSON也会拒绝导出', async () => {
    const seed = createSeed(), drawing = await drawingAsset('cache-check');
    Object.values(seed.documents).forEach(doc => { if (doc.assetId) doc.hash = digest(new TextEncoder().encode('%PDF-1.4\nsynthetic fixture\n%%EOF')); });
    seed.boards['board-a'].drawing = drawing.ref;
    vi.mocked(getAsset).mockImplementation(async id => id === drawing.ref.assetId ? drawing.blob : pdf);
    await buildResearchFiles(seed, 'research-a');
    vi.mocked(getAsset).mockImplementation(async id => id === drawing.ref.assetId ? new Blob(['corrupt']) : pdf);
    await expect(buildResearchFiles(seed, 'research-a')).rejects.toThrow(/hash/);
    const invalid = new Blob(['{}']), hash = digest(await invalid.arrayBuffer());
    seed.boards['board-a'].drawing = { assetId: `drawing-${hash}`, hash };
    vi.mocked(getAsset).mockImplementation(async id => id === `drawing-${hash}` ? invalid : pdf);
    await expect(buildResearchFiles(seed, 'research-a')).rejects.toThrow(/绘图/);
  });

  it('同一资产被多个引用要求不同hash时，在已有文件和缓存命中后仍拒绝导出', async () => {
    const seed = createSeed(), hash = digest(await pdf.arrayBuffer());
    Object.values(seed.documents).forEach(doc => { if (doc.assetId) doc.hash = hash; });
    await buildResearchFiles(seed, 'research-a');
    seed.documents['paper-b'].assetId = seed.documents['paper-a'].assetId;
    seed.documents['paper-b'].hash = 'a'.repeat(64);
    await expect(buildResearchFiles(seed, 'research-a')).rejects.toThrow(/hash 不一致/);
  });

  it('导出历史及其已移出白板的材料，不泄露其他研究历史', async () => {
    const seed = createSeed(), next = structuredClone(seed);
    delete next.placements['placement-b']; delete next.edges['edge-a'];
    next.researches['research-a'].cardIds = next.researches['research-a'].cardIds.filter(id => id !== 'card-b');
    next.boards['board-b'].title = '研究B的修改';
    recordBoardChanges(seed, next);
    const exported = researchFileData(next, 'research-a');
    expect(Object.values(exported.boardChanges)).toHaveLength(1);
    expect(exported.boardRevisions).toEqual({ 'board-a': 1 });
    expect(exported.cards['card-b']).toBeDefined();
    expect(exported.documents['paper-b']).toBeDefined();
    expect(JSON.stringify(exported)).not.toContain('研究B的修改');
    Object.values(next.documents).forEach(doc => { if (doc.assetId) doc.hash = digest(new TextEncoder().encode('%PDF-1.4\nsynthetic fixture\n%%EOF')); });
    const { files } = await buildResearchFiles(next, 'research-a');
    expect(JSON.parse(files.find(file => file.path === 'research.json')!.content).entities.boardChanges).toEqual(exported.boardChanges);
  });
  it('包含实际PDF、卡片、摘录、文稿、白板、对话和稳定ID的结构化数据', async () => {
    const seed = createSeed(), hash = digest(await pdf.arrayBuffer());
    Object.values(seed.documents).forEach(doc => { if (doc.assetId) doc.hash = hash; });
    Object.assign(seed.conversations['conversation-research-a'], { connectionId: 'codex', nativeSessionId: 'native-session-a' });
    seed.requests['native-complete'] = { id: 'native-complete', researchId: 'research-a', conversationId: 'conversation-research-a', connectionId: 'codex',
      prompt: '最初的问题', body: '完整回答', supplementalInputs: [{ id: 'steer-export', text: '已确认的本轮补充', createdAt: '2026-10-19T00:00:00.000Z' }],
      status: 'done', context: [], evidenceIds: [], createdAt: '2026-10-19T00:00:00.000Z', purpose: 'chat', mode: 'live' };
    seed.conversations['conversation-research-a'].requestIds.push('native-complete');
    const { files } = await buildResearchFiles(seed, 'research-a');
    const map = Object.fromEntries(files.map(file => [file.path, file]));
    expect(Buffer.from(map['library/paper-a.pdf'].content, 'base64')).toEqual(Buffer.from(await pdf.arrayBuffer()));
    expect(map['cards/card-a.md'].content).toContain(seed.cards['card-a'].body);
    expect(map['cards/card-a.md'].content).toContain('PDF 第');
    expect(map['library/paper-stub.md'].content).toContain('尚未添加全文');
    expect(map['sessions/conversation-research-a.md'].content).toContain('codex resume native-session-a');
    expect(map['sessions/conversation-research-a.md'].content).toContain('已确认的本轮补充');
    const saved = JSON.parse(map['research.json'].content);
    expect(saved.format).toBe('papertrail-research');
    expect(Object.keys(saved.entities.research)).toContain('documentIds');
    expect(saved.entities.research.id).toBe('research-a');
    expect(saved.entities.requests['native-complete'].supplementalInputs[0].text).toBe('已确认的本轮补充');
    expect(map['README.md'].content).toContain('原生会话');
    for (const file of files) expect(file.hash).toBe(digest(file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : new TextEncoder().encode(file.content).buffer));
  });
  it('不复制其他研究的私有对话，仍包含共享卡片所必需的原文', () => {
    const seed = createSeed();
    seed.conversations['conversation-research-b'].input = '研究B的私人输入';
    seed.researches['research-b'].cardIds = ['card-a'];
    const a = researchFileData(seed, 'research-a'), b = researchFileData(seed, 'research-b');
    expect(JSON.stringify(a)).not.toContain('研究B的私人输入');
    expect(b.cards['card-a']).toBeDefined();
    expect(b.documents['paper-a']).toBeDefined();
    expect(b.evidence['evidence-a']).toBeDefined();
  });
  it('缺失原资产或hash不一致时拒绝假成功', async () => {
    const seed = createSeed(); seed.documents['paper-a'].hash = 'f'.repeat(64);
    await expect(buildResearchFiles(seed, 'research-a')).rejects.toThrow('hash');
    const missing = createSeed(); missing.documents['paper-a'].sampleUrl = undefined; missing.documents['paper-a'].assetId = 'missing-unique';
    vi.mocked(getAsset).mockResolvedValue(undefined);
    await expect(buildResearchFiles(missing, 'research-a')).rejects.toThrow('缺失');
  });
  it('JPEG区域导出为jpg，图片字节、Markdown引用与JSON资产路径保持一致', async () => {
    const seed = createSeed(), hash = digest(await pdf.arrayBuffer());
    Object.values(seed.documents).forEach(doc => { if (doc.assetId) doc.hash = hash; });
    const jpeg = new Blob(['jpeg region fixture'], { type: 'image/jpeg' }), imageHash = digest(await jpeg.arrayBuffer());
    const assetId = 'region-jpeg-fixture';
    seed.evidence['evidence-a'].kind = 'region';
    seed.evidence['evidence-a'].region = { assetId, hash: imageHash, rect: { x: 0, y: 0, width: 0.5, height: 0.5 }, rotation: 0, width: 50, height: 50 };
    vi.mocked(getAsset).mockImplementation(async id => id === assetId ? jpeg : pdf);
    const { files } = await buildResearchFiles(seed, 'research-a');
    const map = Object.fromEntries(files.map(file => [file.path, file]));
    const imagePath = `images/${assetId}.jpg`;
    expect(Buffer.from(map[imagePath].content, 'base64')).toEqual(Buffer.from(await jpeg.arrayBuffer()));
    expect(map[`images/${assetId}.png`]).toBeUndefined();
    expect(map['excerpts/evidence-a.md'].content).toContain(`(../${imagePath})`);
    expect(map['cards/card-a.md'].content).toContain(`(../${imagePath})`);
    expect(JSON.parse(map['research.json'].content).assets[assetId]).toEqual({ path: imagePath, hash: imageHash, type: 'image/jpeg' });
  });
});
