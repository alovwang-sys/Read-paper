import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { startSystemDictation } from './dictation.mjs';

function fixture() {
  const frame = { url: 'papertrail://app/' };
  const contents = { mainFrame: frame, isFocused: () => true };
  const window = { webContents: contents, isDestroyed: () => false, isFocused: () => true };
  const calls = [];
  return { event: { sender: contents, senderFrame: frame }, window, url: frame.url, platform: 'darwin', sendAction: action => calls.push(action), calls };
}

test('macOS仅向已聚焦工作台派发固定的系统听写命令，不开始应用内录音', () => {
  const request = fixture();
  assert.equal(startSystemDictation(request), true);
  assert.deepEqual(request.calls, ['startDictation:']);
});

test('系统听写拒绝其他窗口、子框架、外部来源和已销毁窗口', () => {
  const changes = [
    request => { request.event.sender = {}; },
    request => { request.event.senderFrame = { url: request.url }; },
    request => { request.event.senderFrame.url = 'papertrail://app/desktop-settings'; },
    request => { request.window.isDestroyed = () => true; },
    request => { request.window = undefined; },
  ];
  for (const change of changes) {
    const request = fixture(); change(request);
    assert.throws(() => startSystemDictation(request), /不允许此页面/);
    assert.deepEqual(request.calls, []);
  }
});

test('失焦时不向其他客户端发送系统命令，其他系统返回快捷键引导', () => {
  for (const target of ['window', 'contents']) {
    const request = fixture();
    (target === 'window' ? request.window : request.window.webContents).isFocused = () => false;
    assert.throws(() => startSystemDictation(request), /回到工作台输入框/);
    assert.deepEqual(request.calls, []);
  }
  for (const platform of ['win32', 'linux']) {
    const request = fixture(); request.platform = platform;
    assert.equal(startSystemDictation(request), false);
    assert.deepEqual(request.calls, []);
  }
});

test('preload仅暴露无参数听写动作，不能传入任意原生selector或IPC', async () => {
  let bridge;
  const calls = [];
  const electron = { contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'papertrailDesktop'); bridge = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(true); } } };
  runInNewContext(await readFile(new URL('./preload.cjs', import.meta.url), 'utf8'), { require: name => { assert.equal(name, 'electron'); return electron; } });
  assert.equal(await bridge.startDictation('quit:', 'papertrail:untrusted'), true);
  assert.deepEqual(calls, [['papertrail:start-dictation']]);
});
