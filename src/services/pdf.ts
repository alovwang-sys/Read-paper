import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { contentHash, getAsset, putAsset } from '../data/storage';
import type { PaperDocument, WorkspaceScope } from '../domain/types';
import { hasFullText } from '../domain/knowledge';
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
  const loadingTask = getDocument({ data: new Uint8Array(bytes.slice(0)), wasmUrl: '/pdfjs/wasm/' });
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
  if (!hasFullText(doc)) return Promise.reject(new Error('这条资料尚无全文，请先添加 PDF。'));
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

async function preparePdf(file: File) {
  if (file.size > MAX_PDF_BYTES)
    throw new Error('PDF 超过 50 MB，请拆分文件后导入。');
  const bytes = await file.arrayBuffer();
  checkPdfBytes(bytes);
  const hash = await contentHash(bytes);
  const pdf = await parsePdf(bytes);
  return { bytes, hash, pdf };
}

async function resolveSampleHashes() {
  // Unopened bundled samples participate in content-hash deduplication.
  for (const sample of Object.values(workspace.getState().data.documents).filter(doc => !doc.hash && doc.sampleUrl)) {
    try {
      const loaded = await loadPdfDocument(sample);
      workspace.updateData(data => {
        if (data.documents[sample.id] && !data.documents[sample.id].hash) data.documents[sample.id].hash = loaded.hash;
      });
    } catch {
      /* A missing sample must not prevent importing a user's valid file. */
    }
  }
}

export async function attachPdf(documentId: string, file: File, options: { automatic?: boolean; generation?: number } = {}): Promise<{ conflict?: { into: string } }> {
  const document = workspace.getState().data.documents[documentId];
  if (!document || hasFullText(document)) throw new Error('只能给无全文资料添加 PDF。');
  const { bytes, hash, pdf } = await preparePdf(file);
  try {
    const unchanged = () => options.generation === undefined || workspace.getGeneration() === options.generation;
    if (!unchanged()) return {};
    try {
      const info = (await pdf.getMetadata()).info as Record<string, unknown>;
      const declared = [info.DOI, info.doi, info.Identifier].filter((value): value is string => typeof value === 'string').map(value => value.replace(/^doi:\s*/i, '').toLowerCase()).find(value => /^10\.\d{4,9}\/\S+$/.test(value));
      if (declared && document.identifiers?.doi && declared !== document.identifiers.doi) throw new Error('PDF 中的 DOI 与这条资料不一致，请核对来源后重新选择。');
    } catch (error) {
      if (error instanceof Error && error.message.includes('DOI 与')) throw error;
      // Missing PDF metadata does not prove a mismatch; the source remains explicitly user-selected.
    }
    await resolveSampleHashes();
    if (!unchanged()) return {};
    if (options.automatic && hasFullText(workspace.getState().data.documents[documentId])) return {};
    const existing = Object.values(workspace.getState().data.documents).find(doc => doc.id !== documentId && doc.hash === hash);
    if (existing) return { conflict: { into: existing.id } };
    const current = workspace.getState().data.documents[documentId];
    if (options.automatic && hasFullText(current)) return {};
    if (!current || hasFullText(current)) throw new Error('资料状态已变化，请重新打开后重试。');
    const assetId = `pdf-${hash}`;
    await putAsset(assetId, new Blob([bytes], { type: 'application/pdf' }));
    if (!unchanged()) return {};
    workspace.updateData(data => {
      const doc = data.documents[documentId];
      if (options.automatic && hasFullText(doc)) return;
      if (!doc || hasFullText(doc)) throw new Error('资料状态已变化，请重新打开后重试。');
      Object.assign(doc, { filename: file.name, hash, assetId, assetRevision: 1, pageCount: pdf.numPages, textStatus: 'pending', updatedAt: new Date().toISOString() });
      doc.acquisition = undefined;
    });
    cache.delete(assetId);
    if (!options.automatic) {
      await workspace.flushSave();
      workspace.notice('PDF 已添加，可以继续阅读；资料与已有整理保持不变。');
    }
    return {};
  } finally {
    await pdf.loadingTask.destroy();
  }
}

export async function importPdf(file: File, scope: WorkspaceScope, paneId = workspace.getSession(scope).layout?.focusedPaneId) {
  const generation = workspace.getGeneration();
  const { bytes, hash, pdf } = await preparePdf(file);
  try {
    await resolveSampleHashes();
    if (workspace.getGeneration() !== generation) throw new Error('工作区已重新载入，请重新导入。');
    const existing = Object.values(workspace.getState().data.documents).find(
      (doc) => doc.hash === hash,
    );
    const id = existing?.id ?? `document-${hash}`;
    const assetId = existing?.assetId ?? `pdf-${hash}`;
    await putAsset(assetId, new Blob([bytes], { type: 'application/pdf' }));
    if (workspace.getGeneration() !== generation) throw new Error('工作区已重新载入，请重新导入。');
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
      if (workspace.getGeneration() !== generation) throw new Error('工作区已重新载入，请重新导入。');
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
          updatedAt: new Date().toISOString(),
        };
      });
    }
    if (scope.kind === 'research')
      workspace.associateDocument(scope.researchId, id);
    if (scopeKey(workspace.getState().data.scope) === scopeKey(scope)) {
      try { workspace.openResource({ kind: 'document', id }, { scope, target: 'main', paneId }); }
      catch { workspace.notice('PDF 已导入；原窗格已关闭，可从资料列表打开。'); return id; }
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

export async function importPdfFiles(files: File[], scope: WorkspaceScope, paneId = workspace.getSession(scope).layout?.focusedPaneId) {
  const result = { created: 0, reused: 0, failures: [] as { filename: string; message: string }[], documentIds: [] as string[] };
  for (const file of files) {
    const ids = new Set(Object.keys(workspace.getState().data.documents));
    try {
      const id = await importPdf(file, scope, paneId);
      result.documentIds.push(id);
      if (ids.has(id)) result.reused++;
      else result.created++;
    } catch (error) {
      result.failures.push({ filename: file.name, message: error instanceof Error ? error.message : '导入失败，请重试。' });
    }
  }
  workspace.notice(`导入完成：新建 ${result.created} 条，复用 ${result.reused} 条，失败 ${result.failures.length} 个。`);
  return result;
}
