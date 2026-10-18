import { Agent } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

function assistantMessage(model, content = []) {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending', timestamp: Date.now(),
  };
}

function toPiMessage(message, model) {
  const content = typeof message.content === 'string' ? message.content : message.content.map((part) => {
    if (part.type === 'text') return { ...part };
    const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
    return { type: 'image', mimeType, data };
  });
  if (message.role === 'assistant') {
    return { ...assistantMessage(model, typeof content === 'string' ? [{ type: 'text', text: content }] : content), stopReason: 'stop' };
  }
  return { role: message.role, content, timestamp: Date.now() };
}

function toCompletionMessage(message) {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  if (message.role === 'assistant') return { role: 'assistant', content: message.content.map((part) => part.text).join('') };
  return {
    role: message.role,
    content: message.content.map((part) => part.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
      : { type: 'text', text: part.text }),
  };
}

// The shared transport retains strict completion/error checks; Pi owns the run and transcript.
export async function runPiCompletion({ model: modelId, messages, images, signal, streamCompletion, onDelta }) {
  signal.throwIfAborted();
  const model = {
    id: modelId, name: modelId, api: 'openai-completions', provider: 'papertrail', baseUrl: '',
    reasoning: true, input: images ? ['text', 'image'] : ['text'], contextWindow: 0, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  let failure;
  let acknowledgeDelta;
  const agent = new Agent({
    initialState: { model, messages: messages.map((message) => toPiMessage(message, model)), tools: [], thinkingLevel: 'low' },
    finishTurn: () => ({ action: 'end' }),
    streamFn: (_model, context, options) => {
      const stream = createAssistantMessageEventStream();
      const partial = assistantMessage(model);
      void (async () => {
        try {
          const requestSignal = AbortSignal.any([signal, options.signal]);
          requestSignal.throwIfAborted();
          const completion = streamCompletion(context.messages.map(toCompletionMessage), requestSignal);
          let started = false;
          for await (const event of completion) {
            requestSignal.throwIfAborted();
            if (!started) {
              started = true;
              stream.push({ type: 'start', partial });
              partial.content.push({ type: 'text', text: '' });
              stream.push({ type: 'text_start', contentIndex: 0, partial });
            }
            if (event.type === 'delta') {
              partial.content[0].text += event.text;
              const delivered = new Promise((resolve) => { acknowledgeDelta = resolve; });
              stream.push({ type: 'text_delta', contentIndex: 0, delta: event.text, partial });
              await delivered;
              requestSignal.throwIfAborted();
            } else if (event.type === 'done') {
              partial.stopReason = 'stop';
              stream.push({ type: 'text_end', contentIndex: 0, content: partial.content[0].text, partial });
              stream.push({ type: 'done', reason: 'stop', message: partial });
              return;
            }
          }
          throw new Error('内置助手未收到完整回答。');
        } catch (error) {
          failure ??= error;
          partial.stopReason = signal.aborted || options.signal.aborted ? 'aborted' : 'error';
          partial.errorMessage = '内置助手未完成回答。';
          stream.push({ type: 'error', reason: partial.stopReason, error: partial });
        }
      })();
      return stream;
    },
  });
  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      try { await onDelta(event.assistantMessageEvent.delta); }
      catch (error) { failure ??= error; agent.abort(); throw error; }
      finally { acknowledgeDelta?.(); acknowledgeDelta = undefined; }
    }
  });
  const abort = () => agent.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const run = agent.continue();
    if (signal.aborted) agent.abort();
    await run;
    signal.throwIfAborted();
    if (failure) throw failure;
    const message = agent.state.messages.at(-1);
    if (message?.role !== 'assistant' || message.stopReason !== 'stop') throw new Error('内置助手未完成回答。');
    return message;
  } finally {
    signal.removeEventListener('abort', abort);
    unsubscribe();
  }
}
