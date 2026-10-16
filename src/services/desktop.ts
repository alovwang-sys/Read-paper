import { stopAllAI } from './ai';
import { workspace } from './workspace';

declare global {
  interface Window {
    papertrailDesktop?: {
      openAISettings(): Promise<void>;
      onAISettingsChanged(callback: () => void): () => void;
      onOpenStorage(callback: () => void): () => void;
      onPrepareClose(callback: (id: string) => void): () => void;
      onCloseCancelled(callback: () => void): () => void;
      closePrepared(id: string, error?: string): void;
    };
  }
}

export function installDesktopLifecycle() {
  let current: string | undefined;
  window.papertrailDesktop?.onCloseCancelled(() => { current = undefined; document.body.inert = false; });
  window.papertrailDesktop?.onPrepareClose(async id => {
    current = id;
    document.body.inert = true;
    try {
      await stopAllAI();
      await workspace.flushSave();
      if (current === id) window.papertrailDesktop?.closePrepared(id);
    } catch (error) {
      if (current === id) {
        document.body.inert = false;
        window.papertrailDesktop?.closePrepared(id, error instanceof Error ? error.message : '无法保存资料。');
      }
    }
  });
}
