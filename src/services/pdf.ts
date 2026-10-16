import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { contentHash, getAsset, putAsset } from '../data/storage';
import type { PaperDocument, WorkspaceScope } from '../domain/types';
import { scopeKey, workspace } from './workspace';

GlobalWorkerOptions.workerSrc = workerUrl;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const cache = new Map<
  string,
  Promise<{ pdf: PDFDocumentProxy; hash: string }>
>();

export function checkPdfBytes(bytes: ArrayBuffer) {
  if (!bytes.byteLength) throw new Error('文件为空，请选择有效的 PDF。');
  if (bytes.byteLength > MAX_PDF_BYTES)
    throw new Error('PDF 超过 50 MB，请拆分文件后导入。');
  const header = new TextDecoder('ascii').decode(bytes.slice(0, 1024));
  if (!header.includes('%PDF-'))
    throw new Error('文件内容不是 PDF，请检查文件后重试。');
}

async function parsePdf(bytes: ArrayBuffer) {
  checkPdfBytes(bytes);
  const loadingTask = getDocument({ data: new Uint8Array(bytes.slice(0)) });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages < 1 || pdf.numPages > 2000) {
      await pdf.loadingTask.destroy();
      throw new Error('支持 1–2000 页的 PDF，请拆分文件后重试。');
    }
    return pdf;
  } catch (error) {
    await loadingTask.destroy().catch(() => {});
    if (error instanceof Error && error.name === 'PasswordException')
      throw new Error('PDF 已加密，请先使用密码解密并导出后重新导入。');
    throw new Error(
      `PDF 无法解析：${error instanceof Error ? error.message : '文件可能已损坏'}。请重新导出文件后重试。`,
    );
  }
}

export function loadPdfDocument(doc: PaperDocument, retry = false) {
  if (retry) cache.delete(doc.assetId);
  const saved = cache.get(doc.assetId);
  if (saved) return saved;
  const loading = (async () => {
    let blob = await getAsset(doc.assetId);
    const missingAsset = !blob;
    if (!blob && doc.sampleUrl) {
      const response = await fetch(doc.sampleUrl);
      if (!response.ok)
        throw new Error('示例 PDF 获取失败，请检查连接后重试。');
      blob = await response.blob();
    }
    if (!blob)
      throw new Error(
        '原 PDF 文件缺失。请重新导入同一文件；相同内容会修复资产并保留已有证据。',
      );
    const bytes = await blob.arrayBuffer();
    checkPdfBytes(bytes);
    const hash = await contentHash(bytes);
    if (doc.hash && doc.hash !== hash)
      throw new Error(
        '原文件内容与保存的来源不一致，请导入为新论文后建立新的引用。',
      );
    const pdf = await parsePdf(bytes);
    if (missingAsset) {
      try {
        await putAsset(doc.assetId, blob);
      } catch (error) {
        await pdf.loadingTask.destroy();
        throw error;
      }
    }
    return { pdf, hash };
  })();
  cache.set(doc.assetId, loading);
  loading.catch(() => {
    if (cache.get(doc.assetId) === loading) cache.delete(doc.assetId);
  });
  return loading;
}

export async function importPdf(file: File, scope: WorkspaceScope) {
  if (file.size > MAX_PDF_BYTES)
    throw new Error('PDF 超过 50 MB，请拆分文件后导入。');
  const bytes = await file.arrayBuffer();
  checkPdfBytes(bytes);
  const hash = await contentHash(bytes);
  const pdf = await parsePdf(bytes);
  try {
    // Unopened bundled samples participate in the same content-hash deduplication.
    const samples = Object.values(workspace.getState().data.documents).filter(
      (doc) => !doc.hash && doc.sampleUrl,
    );
    for (const sample of samples) {
      try {
        const loaded = await loadPdfDocument(sample);
        workspace.updateData((data) => {
          if (data.documents[sample.id] && !data.documents[sample.id].hash)
            data.documents[sample.id].hash = loaded.hash;
        });
      } catch {
        /* A missing sample must not prevent importing a user's valid file. */
      }
    }
    const existing = Object.values(workspace.getState().data.documents).find(
      (doc) => doc.hash === hash,
    );
    const id = existing?.id ?? `document-${hash}`;
    const assetId = existing?.assetId ?? `pdf-${hash}`;
    await putAsset(assetId, new Blob([bytes], { type: 'application/pdf' }));
    cache.delete(assetId);
    if (existing)
      workspace.updateData((data) => {
        const doc = data.documents[id];
        doc.assetRevision = (doc.assetRevision ?? 0) + 1;
      });
    if (!existing) {
      let title = file.name.replace(/\.pdf$/i, ''),
        authors = '';
      try {
        const info = (await pdf.getMetadata()).info as Record<string, unknown>;
        if (typeof info.Title === 'string' && info.Title.trim())
          title = info.Title.trim();
        if (typeof info.Author === 'string') authors = info.Author;
      } catch {
        /* File metadata is optional; the source file remains intact. */
      }
      workspace.updateData((data) => {
        data.documents[id] = {
          id,
          title,
          authors,
          year: '',
          filename: file.name,
          hash,
          assetId,
          pageCount: pdf.numPages,
          readingStatus: 'unread',
          textStatus: 'pending',
        };
      });
    }
    if (scope.kind === 'research')
      workspace.associateDocument(scope.researchId, id);
    if (scopeKey(workspace.getState().data.scope) === scopeKey(scope)) {
      workspace.openResource(
        { kind: 'document', id },
        { scope, target: 'main' },
      );
      workspace.notice(
        existing
          ? '已打开已有论文；原文件资产已恢复。'
          : 'PDF 已导入，并保存在本地。',
      );
    } else workspace.notice('PDF 导入完成，已归入开始导入时的研究或资料库。');
    return id;
  } finally {
    await pdf.loadingTask.destroy();
  }
}
