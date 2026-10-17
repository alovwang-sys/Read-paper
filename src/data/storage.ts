import type { WorkspaceData } from '../domain/types';

let connection: Promise<IDBDatabase> | undefined;
function database() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('papertrail', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('workspace');
      request.result.createObjectStore('assets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      connection = undefined;
      reject(request.error);
    };
  });
  return connection;
}
async function read<T>(store: string, id: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(store: string, id: string, value: unknown) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('保存被中止'));
    transaction.objectStore(store).put(value, id);
  });
}
export const loadWorkspace = () => read<WorkspaceData>('workspace', 'current');
export const saveWorkspace = (data: WorkspaceData) =>
  write('workspace', 'current', data);
export const saveMigrationBackup = (value: unknown) =>
  write('workspace', 'before-schema-3', value);
export const getAsset = (id: string) => read<Blob>('assets', id);
export const putAsset = (id: string, blob: Blob) => write('assets', id, blob);
export async function exportAllAssets(): Promise<Array<{ id: string; blob: Blob }>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const assets: Array<{ id: string; blob: Blob }> = [];
    const transaction = db.transaction('assets');
    const request = transaction.objectStore('assets').openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { assets.push({ id: String(cursor.key), blob: cursor.value }); cursor.continue(); }
    };
    transaction.oncomplete = () => resolve(assets);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('资产读取被中止'));
  });
}
export async function restoreWorkspaceBackup(data: WorkspaceData, assets: Array<{ id: string; blob: Blob }>) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['workspace', 'assets'], 'readwrite');
    const workspaces = transaction.objectStore('workspace');
    const files = transaction.objectStore('assets');
    const current = workspaces.get('current');
    const previous: Array<{ id: string; blob: Blob }> = [];
    const cursor = files.openCursor();
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) { previous.push({ id: String(item.key), blob: item.value }); item.continue(); return; }
      // One transaction preserves the old library and replaces both data and files.
      workspaces.put({ data: current.result, assets: previous, createdAt: new Date().toISOString() }, 'before-backup-restore');
      workspaces.put(data, 'current');
      files.clear();
      assets.forEach(({ id, blob }) => files.put(blob, id));
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('资料恢复被中止，原资料已保留'));
  });
}
export async function contentHash(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
