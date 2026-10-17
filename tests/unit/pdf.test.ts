import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaperDocument, WorkspaceScope } from '../../src/domain/types';

const mocks = vi.hoisted(() => {
  const data: {
    scope: WorkspaceScope;
    documents: Record<string, PaperDocument>;
  } = { scope: { kind: 'library' }, documents: {} };
  return {
    data,
    putAsset: vi.fn(),
    openResource: vi.fn(),
    associateDocument: vi.fn(),
    notice: vi.fn(),
    destroy: vi.fn(),
    getDocument: vi.fn(),
  };
});
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: mocks.getDocument,
}));
vi.mock('../../src/data/storage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAsset: vi.fn(),
  putAsset: mocks.putAsset,
}));
vi.mock('../../src/services/workspace', () => ({
  scopeKey: (scope: WorkspaceScope) =>
    scope.kind === 'library' ? 'library' : scope.researchId,
  workspace: {
    getState: () => ({ data: mocks.data }),
    updateData: (change: (data: typeof mocks.data) => void) =>
      change(mocks.data),
    associateDocument: mocks.associateDocument,
    openResource: mocks.openResource,
    notice: mocks.notice,
  },
}));
import {
  checkPdfBytes,
  attachPdf,
  importPdf,
  importPdfFiles,
  loadPdfDocument,
  MAX_PDF_BYTES,
} from '../../src/services/pdf';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.putAsset.mockResolvedValue(undefined);
  mocks.data.documents = {};
  mocks.data.scope = { kind: 'library' };
  const loadingTask = { destroy: mocks.destroy };
  mocks.getDocument.mockImplementation(() => ({
    promise: Promise.resolve({
      numPages: 3,
      loadingTask,
      getMetadata: async () => ({
        info: { Title: 'Original title', Author: 'Fixture author' },
      }),
    }),
    destroy: mocks.destroy,
  }));
});

describe('PDF import boundaries', () => {
  it('rejects empty, non-PDF and oversized input before parsing', () => {
    expect(() => checkPdfBytes(new ArrayBuffer(0))).toThrow('文件为空');
    expect(() =>
      checkPdfBytes(new TextEncoder().encode('not a pdf').buffer),
    ).toThrow('不是 PDF');
    expect(() => checkPdfBytes(new ArrayBuffer(MAX_PDF_BYTES + 1))).toThrow(
      '50 MB',
    );
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('deduplicates by real SHA-256 and repairs the same asset without replacing metadata', async () => {
    const first = await importPdf(
      new File(['%PDF-1.7\nfixture'], 'first.pdf'),
      { kind: 'library' },
    );
    mocks.data.documents[first].title = 'User edited title';
    const second = await importPdf(
      new File(['%PDF-1.7\nfixture'], 'renamed.pdf'),
      { kind: 'library' },
    );
    expect(second).toBe(first);
    expect(Object.keys(mocks.data.documents)).toHaveLength(1);
    expect(mocks.data.documents[first].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.data.documents[first].title).toBe('User edited title');
    expect(mocks.data.documents[first].filename).toBe('first.pdf');
    expect(mocks.data.documents[first].assetRevision).toBe(1);
    expect(mocks.putAsset.mock.calls[0][0]).toBe(
      mocks.putAsset.mock.calls[1][0],
    );
  });

  it('binds a pending import to its original research without switching the current research back', async () => {
    mocks.data.scope = { kind: 'research', researchId: 'research-b' };
    const id = await importPdf(
      new File(['%PDF-1.7\nother fixture'], 'paper.pdf'),
      { kind: 'research', researchId: 'research-a' },
    );
    expect(mocks.associateDocument).toHaveBeenCalledWith('research-a', id);
    expect(mocks.openResource).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledWith(
      expect.stringContaining('开始导入时'),
    );
  });

  it('attaches a first PDF without changing a stub ID or edited metadata', async () => {
    mocks.data.documents['document-stub'] = { id: 'document-stub', title: 'My title', authors: 'My author', year: '2026', identifiers: { doi: '10.1234/test' }, readingStatus: 'skimmed', textStatus: 'pending' };
    const result = await attachPdf('document-stub', new File(['%PDF-1.7\nattach fixture'], 'fulltext.pdf'));
    expect(result.conflict).toBeUndefined();
    expect(Object.keys(mocks.data.documents)).toEqual(['document-stub']);
    expect(mocks.data.documents['document-stub']).toMatchObject({ id: 'document-stub', title: 'My title', authors: 'My author', year: '2026', readingStatus: 'skimmed', identifiers: { doi: '10.1234/test' }, filename: 'fulltext.pdf', pageCount: 3, assetRevision: 1 });
    expect(mocks.data.documents['document-stub'].hash).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.associateDocument).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalled();
    await expect(attachPdf('document-stub', new File(['%PDF-1.7\nreplace'], 'replacement.pdf'))).rejects.toThrow('只能给无全文');
  });

  it('reports an existing hash without saving an asset or changing either document', async () => {
    const file = new File(['%PDF-1.7\nconflict'], 'existing.pdf');
    const existingId = await importPdf(file, { kind: 'library' });
    mocks.data.documents.stub = { id: 'stub', title: 'Stub', authors: '', year: '', readingStatus: 'unread', textStatus: 'pending' };
    const before = structuredClone(mocks.data.documents);
    mocks.putAsset.mockClear();
    const result = await attachPdf('stub', file);
    expect(result).toEqual({ conflict: { into: existingId } });
    expect(mocks.putAsset).not.toHaveBeenCalled();
    expect(mocks.data.documents).toEqual(before);
  });

  it('leaves a stub unchanged when saving its asset fails, allowing retry', async () => {
    mocks.data.documents.stub = { id: 'stub', title: 'Stub', authors: '', year: '', readingStatus: 'unread', textStatus: 'pending' };
    const before = structuredClone(mocks.data.documents.stub);
    mocks.putAsset.mockRejectedValueOnce(new Error('磁盘已满'));
    const file = new File(['%PDF-1.7\nretry'], 'retry.pdf');
    await expect(attachPdf('stub', file)).rejects.toThrow('磁盘已满');
    expect(mocks.data.documents.stub).toEqual(before);
    await expect(attachPdf('stub', file)).resolves.toEqual({});
    expect(mocks.data.documents.stub.filename).toBe('retry.pdf');
  });

  it('imports files sequentially, counts reuse and keeps valid files after an individual failure', async () => {
    const result = await importPdfFiles([
      new File(['%PDF-1.7\none'], 'one.pdf'),
      new File(['broken'], 'broken.pdf'),
      new File(['%PDF-1.7\none'], 'duplicate.pdf'),
      new File(['%PDF-1.7\ntwo'], 'two.pdf'),
    ], { kind: 'library' });
    expect(result).toMatchObject({ created: 2, reused: 1, failures: [{ filename: 'broken.pdf', message: expect.stringContaining('不是 PDF') }] });
    expect(Object.keys(mocks.data.documents)).toHaveLength(2);
    expect(result.documentIds).toHaveLength(3);
  });

  it('rejects opening a stub before accessing or parsing assets', async () => {
    await expect(loadPdfDocument({ id: 'stub', title: 'Stub', authors: '', year: '', readingStatus: 'unread', textStatus: 'pending' })).rejects.toThrow('尚无全文');
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
});
