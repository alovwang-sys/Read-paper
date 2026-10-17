import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { installFullscreenShortcut } from './window-shortcuts.mjs';

test('preload只暴露固定全屏查询与退出动作，不接受任意窗口命令', async () => {
  let bridge;
  const calls = [];
  runInNewContext(await readFile(new URL('./preload.cjs', import.meta.url), 'utf8'), { require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(false); } } };
  } });
  await bridge.getFullScreen('papertrail:other');
  await bridge.exitFullScreen(true, 'destroy');
  assert.deepEqual(calls, [['papertrail:get-fullscreen'], ['papertrail:exit-fullscreen']]);
});

test('全屏订阅只传状态，卸载时移除同一个监听器', async () => {
  let bridge, listener;
  const received = [], removed = [];
  runInNewContext(await readFile(new URL('./preload.cjs', import.meta.url), 'utf8'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
    ipcRenderer: {
      on: (channel, callback) => { assert.equal(channel, 'papertrail:fullscreen-changed'); listener = callback; },
      removeListener: (channel, callback) => removed.push([channel, callback]),
    },
  }) });
  const unsubscribe = bridge.onFullScreenChanged((...values) => received.push(values));
  listener({ privateSender: true }, true); listener({ privateSender: true }, false); unsubscribe();
  assert.deepEqual(received, [[true], [false]]);
  assert.deepEqual(removed, [['papertrail:fullscreen-changed', listener]]);
});

test('工作台全屏快捷键阻止menu重复触发，长按不反复切换且不抢Esc或组合输入', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    let listener, fullScreen = false, prevented = 0;
    const transitions = [];
    const window = {
      webContents: { on: (name, callback) => { assert.equal(name, 'before-input-event'); listener = callback; } },
      isFullScreen: () => fullScreen,
      setFullScreen: value => { transitions.push(value); fullScreen = value; },
    };
    installFullscreenShortcut(window, platform);
    const event = { preventDefault: () => prevented++ };
    const input = { type: 'keyDown', key: platform === 'darwin' ? 'f' : 'F11', control: platform === 'darwin', meta: platform === 'darwin', shift: false, alt: false, isComposing: false, isAutoRepeat: false };
    listener(event, input); assert.deepEqual(transitions, [true]);
    listener(event, { ...input, isAutoRepeat: true }); assert.deepEqual(transitions, [true]);
    assert.equal(prevented, 2);
    for (const change of [{ type: 'keyUp' }, { key: 'Escape' }, { isComposing: true }, { shift: true }, { alt: true }, { control: platform !== 'darwin' }]) listener(event, { ...input, ...change });
    assert.deepEqual(transitions, [true]); assert.equal(prevented, 2);
    listener(event, input); assert.deepEqual(transitions, [true, false]); assert.equal(prevented, 3);
  }
});
