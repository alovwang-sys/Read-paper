import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createAIHandler, validateAISettings } from '../server/ai.mjs';

export async function startDesktopAI({ env = {}, fetchImpl, timeoutMs } = {}) {
  validateAISettings(env);
  const token = randomBytes(32).toString('base64url');
  const sockets = new Set();
  const server = createServer();
  server.requestTimeout = 30_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let handler;
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await handler?.stop();
      await closed;
    })();
    return stopping;
  };
  try {
    const listening = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await listening;
    const port = server.address().port;
    handler = createAIHandler({ env: { ...env, AI_PORT: String(port) }, fetchImpl, timeoutMs, localToken: token });
    server.on('request', handler);
    return { baseURL: `http://127.0.0.1:${port}`, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
