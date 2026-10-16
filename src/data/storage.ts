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
  write('workspace', 'before-schema-2', value);
export const getAsset = (id: string) => read<Blob>('assets', id);
export const putAsset = (id: string, blob: Blob) => write('assets', id, blob);
export async function contentHash(bytes: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
