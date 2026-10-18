import { useEffect, useState } from 'react';
import { Minimize2 } from 'lucide-react';
import './desktop-window-controls.css';

export function DesktopWindowControls() {
  const [fullScreen, setFullScreen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const shortcut = /Mac/i.test(navigator.platform) ? '⌃⌘F' : 'F11';

  useEffect(() => {
    const desktop = window.papertrailDesktop;
    if (!desktop?.getFullScreen || !desktop.exitFullScreen || !desktop.onFullScreenChanged) return;
    let active = true, changed = false;
    const unsubscribe = desktop.onFullScreenChanged(value => {
      changed = true;
      if (active) { setFullScreen(value); setError(''); }
    });
    // A transition received after subscribing takes precedence over the initial reply.
    void desktop.getFullScreen().then(value => { if (active && !changed) setFullScreen(value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);

  async function exit() {
    setPending(true); setError('');
    try { await window.papertrailDesktop?.exitFullScreen?.(); }
    catch { setError(`未能退出全屏，请按 ${shortcut} 重试。`); }
    finally { setPending(false); }
  }

  if (!fullScreen) return null;
  return <div className="desktop-window-controls">
    <button type="button" className="desktop-exit-fullscreen" aria-label="退出全屏" title={`退出全屏 · ${shortcut}`} disabled={pending} onClick={() => void exit()}>
      <Minimize2 size={15} aria-hidden="true" /><span>退出全屏</span>
    </button>
    {error && <span className="desktop-fullscreen-error" role="alert">{error}</span>}
  </div>;
}
