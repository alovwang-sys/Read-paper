import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A pared-down copy of what `codex app-server generate-json-schema --experimental` writes (0.165.0 layout); `drop` imitates a release that removed names.
export async function writeCodexSchema(dir, { drop = [] } = {}) {
  const keep = names => names.filter(name => !drop.includes(name));
  const union = names => ({ oneOf: keep(names).map(method => ({ properties: { method: { enum: [method] } } })) });
  const properties = names => Object.fromEntries(keep(names).map(name => [name, {}]));
  await mkdir(join(dir, 'v2'), { recursive: true });
  const files = {
    'ClientRequest.json': union(['initialize', 'account/read', 'config/read', 'command/exec', 'thread/start', 'turn/start', 'turn/interrupt', 'model/list', 'collaborationMode/list', 'skills/list']),
    'ServerNotification.json': union(['error', 'item/started', 'item/completed', 'item/agentMessage/delta', 'item/plan/delta', 'turn/completed']),
    'ServerRequest.json': union(['item/tool/call', 'item/commandExecution/requestApproval']),
    'v2/ThreadStartParams.json': { properties: properties(['cwd', 'config', 'developerInstructions', 'dynamicTools', 'ephemeral', 'permissions', 'model']) },
    'v2/TurnStartParams.json': { properties: properties(['threadId', 'input', 'model', 'effort', 'collaborationMode']) },
    'v2/ConfigReadResponse.json': { definitions: { Config: { properties: { web_search: { anyOf: [{ $ref: '#/definitions/WebSearchMode' }, { type: 'null' }] } } }, WebSearchMode: { enum: keep(['disabled', 'cached', 'indexed', 'live']), type: 'string' } } },
    'v2/ItemCompletedNotification.json': { definitions: { ThreadItem: { oneOf: keep(['userMessage', 'agentMessage', 'plan', 'reasoning', 'webSearch', 'dynamicToolCall']).map(type => ({ properties: { type: { enum: [type] } } })) } } },
  };
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(value));
}
