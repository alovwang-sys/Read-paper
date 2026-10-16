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
  importPdf,
  MAX_PDF_BYTES,
} from '../../src/services/pdf';

beforeEach(() => {
  vi.clearAllMocks();
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
});
