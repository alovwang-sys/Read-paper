import test from 'node:test';
import assert from 'node:assert/strict';
import { runPiCompletion } from './pi-runtime.mjs';

const messages = [{ role: 'user', content: '解释这段论文。' }];
const signal = () => new AbortController().signal;

test('real Pi run owns the transcript and forwards only visible text through its lifecycle', async () => {
  const deltas = [];
  let calls = 0;
  const result = await runPiCompletion({
    model: 'glm-5.3-flash', messages, signal: signal(),
    streamCompletion: async function* (transcript, requestSignal) {
      calls += 1;
      assert.deepEqual(transcript, messages);
      assert.equal(requestSignal.aborted, false);
      yield { type: 'delta', text: '原文' };
      yield { type: 'delta', text: '解释' };
      yield { type: 'done' };
    },
    onDelta: (text) => { deltas.push(text); },
  });
  assert.deepEqual(deltas, ['原文', '解释']);
  assert.equal(calls, 1);
  assert.equal(result.role, 'assistant');
  assert.deepEqual(result.content, [{ type: 'text', text: '原文解释' }]);
  assert.equal(result.model, 'glm-5.3-flash');
  assert.equal(result.thinkingLevel, 'low');
  assert.equal(result.stopReason, 'stop');
  assert.equal(typeof result.durationMs, 'number');
});

test('Pi preserves explicitly supplied instructions, history and local image data', async () => {
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } };
  const transcript = [
    { role: 'system', content: '只使用当前研究的显式材料。' },
    { role: 'user', content: '前一轮问题' },
    { role: 'assistant', content: '前一轮回答' },
    { role: 'system', content: [{ type: 'text', text: '本轮不联网。' }] },
    { role: 'user', content: [{ type: 'text', text: '解释这张图' }, image] },
  ];
  await runPiCompletion({
    model: 'custom-vision-model', messages: transcript, images: true, signal: signal(),
    streamCompletion: async function* (actual) {
      assert.deepEqual(actual, transcript);
      assert.equal(JSON.stringify(actual).includes('toolsAdded'), false);
      yield { type: 'delta', text: '图示解释' };
      yield { type: 'done' };
    },
    onDelta: () => {},
  });
});

test('Pi preserves strict transport failures and partial text without retrying', async () => {
  const failure = Object.assign(new Error('响应被截断'), { code: 'stream_interrupted' });
  const deltas = [];
  let calls = 0;
  await assert.rejects(runPiCompletion({
    model: 'glm-5.3-flash', messages, signal: signal(),
    streamCompletion: async function* () {
      calls += 1;
      yield { type: 'delta', text: '部分回答' };
      throw failure;
    },
    onDelta: (text) => { deltas.push(text); },
  }), (error) => error === failure);
  assert.deepEqual(deltas, ['部分回答']);
  assert.equal(calls, 1);
});

test('Pi cannot report completion when its transport ends without an explicit terminal event', async () => {
  await assert.rejects(runPiCompletion({
    model: 'glm-5.3-flash', messages, signal: signal(),
    streamCompletion: async function* () { yield { type: 'delta', text: '未完成' }; },
    onDelta: () => {},
  }), /完整回答/);
});

test('cancellation aborts Pi and the active transport; pre-aborted calls never start', async () => {
  const controller = new AbortController();
  let transportSignal;
  await assert.rejects(runPiCompletion({
    model: 'glm-5.3-flash', messages, signal: controller.signal,
    streamCompletion: async function* (_transcript, requestSignal) {
      transportSignal = requestSignal;
      yield { type: 'delta', text: '部分回答' };
      await new Promise((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true });
      });
    },
    onDelta: () => controller.abort(),
  }), (error) => error.name === 'AbortError');
  assert.equal(transportSignal.aborted, true);
  let started = false;
  await assert.rejects(runPiCompletion({
    model: 'glm-5.3-flash', messages, signal: controller.signal,
    streamCompletion: async function* () { started = true; }, onDelta: () => {},
  }), (error) => error.name === 'AbortError');
  assert.equal(started, false);
});

test('run settlement awaits output delivery and propagates delivery failures', async () => {
  let release;
  let delivered;
  const deliveryStarted = new Promise((resolve) => { delivered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let settled = false;
  let transportFinished = false;
  const options = {
    model: 'glm-5.3-flash', messages, signal: signal(),
    streamCompletion: async function* () {
      yield { type: 'delta', text: '回答' };
      transportFinished = true;
      yield { type: 'done' };
    },
  };
  const run = runPiCompletion({ ...options, onDelta: async () => { delivered(); await gate; } }).then(() => { settled = true; });
  await deliveryStarted;
  assert.equal(settled, false);
  assert.equal(transportFinished, false);
  release();
  await run;
  assert.equal(settled, true);
  assert.equal(transportFinished, true);
  const failure = new Error('写入已关闭');
  await assert.rejects(runPiCompletion({ ...options, onDelta: () => { throw failure; } }), (error) => error === failure);
});
