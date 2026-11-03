import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Self-checks compare what this adapter relies on with what the installed CLI says about itself.
// They never call a model: Claude Code is read from `--help` and each run's init event, Codex from its own protocol schema.

/** Without these a Claude Code run either cannot keep its boundary or cannot start at all. */
export const CLAUDE_REQUIRED = ['--print', '--output-format', '--verbose', '--include-partial-messages', '--safe-mode', '--disable-slash-commands', '--tools', '--strict-mcp-config', '--mcp-config', '--permission-mode'];
export const CLAUDE_WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** Required flags decide whether the connection is usable; optional ones only hide a menu entry, and say so. */
export function checkClaudeHelp(help) {
  const missing = CLAUDE_REQUIRED.filter(flag => !help.includes(flag));
  const choices = help.match(/--permission-mode\b[\s\S]{0,400}?\(choices:([^)]*)\)/)?.[1];
  const modes = choices ? [...choices.matchAll(/"([^"]+)"/g)].map(match => match[1]) : undefined;
  if (modes && !modes.includes('dontAsk')) missing.push('--permission-mode dontAsk');
  const flags = { permissionPrompts: help.includes('--permission-prompts'), effort: help.includes('--effort'), model: help.includes('--model'), web: help.includes('--allowedTools'), plan: !modes || modes.includes('plan') };
  const warnings = [
    !flags.model && '没有 --model 参数：不能选模型，按 CLI 默认模型运行。',
    !flags.effort && '没有 --effort 参数：不能选思考程度，按 CLI 默认运行。',
    !flags.web && '没有 --allowedTools 参数：无法只放行联网工具，已关闭联网检索。',
    !flags.plan && '--permission-mode 不再提供 plan：已隐藏「规划」模式。',
  ].filter(Boolean);
  return { missing, warnings, flags, checked: CLAUDE_REQUIRED.length + (modes ? 1 : 0) + 4 };
}

/** What a run actually opened, from Claude Code's init event, against what this run asked for. */
export function checkClaudeInit(event, { web = false, plan = false } = {}) {
  const allowed = web ? CLAUDE_WEB_TOOLS : [];
  const tools = Array.isArray(event.tools) ? event.tools.filter(tool => typeof tool === 'string') : undefined;
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.map(server => `MCP ${typeof server?.name === 'string' ? server.name : '服务'}`) : [];
  const extra = [...(tools ?? []).filter(tool => !allowed.includes(tool)), ...servers].slice(0, 12);
  const warnings = [];
  if (!tools) warnings.push('Claude Code 启动事件不再报告工具列表，无法核对隔离与联网工具；需要更新本应用的适配。');
  else if (web) {
    const lost = allowed.filter(tool => !tools.includes(tool));
    if (lost.length) warnings.push(`此版本的 Claude Code 没有 ${lost.join('、')} 工具（可能已改名），${lost.length === allowed.length ? '本轮无法联网检索' : '本轮联网能力不完整'}；需要更新本应用的适配。`);
  }
  if (plan && typeof event.permissionMode === 'string' && event.permissionMode !== 'plan') warnings.push(`请求的是 plan 模式，Claude Code 实际为 ${event.permissionMode.slice(0, 40)}；「规划」未按原生方式生效。`);
  return { extra, warnings };
}

// What the Codex adapter sends and listens for; each group names what the user loses when it disappears.
const CODEX_CONTRACT = [
  { in: 'requests', names: ['initialize', 'account/read', 'config/read', 'command/exec', 'thread/start', 'turn/start', 'turn/interrupt'], effect: '研究无法启动' },
  { in: 'requests', names: ['model/list'], effect: '读不到模型菜单' },
  { in: 'requests', names: ['collaborationMode/list'], effect: '无法确认「规划」模式' },
  { in: 'notifications', names: ['item/agentMessage/delta', 'item/completed', 'turn/completed'], effect: '回答可能不显示或不结束' },
  { in: 'notifications', names: ['item/plan/delta'], effect: '规划内容可能不显示' },
  { in: 'serverRequests', names: ['item/tool/call'], effect: '逐页阅读与引用草稿工具无法调用' },
  { in: 'threadStart', names: ['config', 'developerInstructions', 'dynamicTools', 'ephemeral', 'permissions'], effect: '研究会话无法按隔离设置启动' },
  { in: 'turnStart', names: ['model'], effect: '所选模型不会生效' },
  { in: 'turnStart', names: ['effort'], effect: '所选思考程度不会生效' },
  { in: 'turnStart', names: ['collaborationMode'], effect: '「规划」模式不会生效' },
  { in: 'webSearch', names: ['live'], effect: '「自动」模式可能不会联网' },
  { in: 'items', names: ['webSearch'], effect: '联网检索过程不会显示' },
  { in: 'items', names: ['plan'], effect: '规划内容可能不显示' },
];

async function schemaFile(dir, name) {
  for (const path of [join(dir, 'v2', name), join(dir, name)]) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
const methods = schema => (schema?.oneOf ?? schema?.anyOf ?? []).map(entry => entry?.properties?.method?.enum?.[0]).filter(name => typeof name === 'string');
/** Enum values reachable from a schema node through anyOf / oneOf / local $ref. */
function enumValues(node, definitions, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return [];
  seen.add(node);
  const ref = typeof node.$ref === 'string' ? definitions?.[node.$ref.split('/').pop()] : undefined;
  return [...(Array.isArray(node.enum) ? node.enum : []), ...[ref, ...(node.anyOf ?? []), ...(node.oneOf ?? [])].flatMap(child => enumValues(child, definitions, seen))];
}

/** Reads the schema bundle written by `codex app-server generate-json-schema --experimental`. */
export async function checkCodexSchema(dir) {
  let found;
  try {
    const [clientRequest, notification, serverRequest, threadStart, turnStart, configRead, itemCompleted] = await Promise.all(['ClientRequest.json', 'ServerNotification.json', 'ServerRequest.json', 'ThreadStartParams.json', 'TurnStartParams.json', 'ConfigReadResponse.json', 'ItemCompletedNotification.json'].map(name => schemaFile(dir, name)));
    found = {
      requests: methods(clientRequest), notifications: methods(notification), serverRequests: methods(serverRequest),
      threadStart: Object.keys(threadStart?.properties ?? {}), turnStart: Object.keys(turnStart?.properties ?? {}),
      webSearch: enumValues(configRead?.definitions?.Config?.properties?.web_search, configRead?.definitions),
      items: (itemCompleted?.definitions?.ThreadItem?.oneOf ?? []).map(entry => entry?.properties?.type?.enum?.[0]).filter(type => typeof type === 'string'),
    };
  } catch { return { skipped: '此 Codex 的协议说明无法解析，未完成协议自检。' }; }
  if (!found.requests.length || !found.notifications.length) return { skipped: '此 Codex 的协议说明格式已变，未完成协议自检。' };
  const problems = new Map();
  let checked = 0;
  for (const rule of CODEX_CONTRACT) for (const name of rule.names) {
    checked++;
    if (!found[rule.in].includes(name)) problems.set(rule.effect, [...(problems.get(rule.effect) ?? []), name]);
  }
  return { checked, warnings: [...problems].map(([effect, names]) => `协议缺少 ${names.join('、')}：${effect}；需要更新本应用的适配。`) };
}
