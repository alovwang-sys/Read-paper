export function startSystemDictation({ event, window, url, platform, sendAction }) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== url)
    throw new Error('不允许此页面请求系统听写。');
  if (platform !== 'darwin') return false;
  if (!window.isFocused() || !window.webContents.isFocused())
    throw new Error('请先回到工作台输入框，再使用系统听写。');
  // The OS owns recording and permission UI; dispatching does not confirm that dictation started.
  sendAction('startDictation:');
  return true;
}
