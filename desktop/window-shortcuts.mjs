export function installFullscreenShortcut(window, platform) {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isComposing || input.alt || input.shift) return;
    const matches = platform === 'darwin'
      ? input.control && input.meta && input.key.toLowerCase() === 'f'
      : !input.control && !input.meta && input.key === 'F11';
    if (!matches) return;
    // Consume the menu accelerator too so one key press cannot toggle twice.
    event.preventDefault();
    if (!input.isAutoRepeat) window.setFullScreen(!window.isFullScreen());
  });
}
