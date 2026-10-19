import { mkdir, readFile, writeFile, rename, readdir, rm, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const identityKeys = ['workspaceId', 'requestId', 'researchId', 'conversationId', 'connectionId'];
const terminal = new Set(['completed', 'failed', 'interrupted', 'unknown']);
const activeStates = new Set(['running', 'waiting-input', 'compacting', 'stopping']);
const failure = (code, message) => Object.assign(new Error(message), { code, status: 500 });
const keyOf = identity => createHash('sha256').update(JSON.stringify(identityKeys.map(key => identity[key]))).digest('hex');
const sameIdentity = (left, right) => identityKeys.every(key => left?.[key] === right?.[key]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validIdentity = identity => object(identity) && identityKeys.every(key => typeof identity[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identity[key]));
const validSnapshot = snapshot => object(snapshot) && Number.isSafeInteger(snapshot.seq) && snapshot.seq >= 0
  && [...activeStates, ...terminal].includes(snapshot.state) && ['pending', 'accepted', 'unknown'].includes(snapshot.delivery)
  && typeof snapshot.body === 'string' && snapshot.body.length <= 1_000_000
  && Array.isArray(snapshot.items) && snapshot.items.length <= 256 && snapshot.items.every(item => object(item) && typeof item.id === 'string' && item.id.length <= 240 && typeof item.type === 'string' && ['running', 'done', 'error'].includes(item.status) && (item.text === undefined || typeof item.text === 'string' && item.text.length <= 1_000_000))
  && Array.isArray(snapshot.events) && snapshot.events.length <= 100 && snapshot.events.every(item => object(item) && ['tool', 'status', 'permission'].includes(item.kind) && typeof item.text === 'string' && item.text.length <= 2000)
  && Array.isArray(snapshot.interactions) && snapshot.interactions.length <= 64 && snapshot.interactions.every(item => object(item) && typeof item.id === 'string' && ['approval', 'question'].includes(item.kind) && ['pending', 'answered', 'denied', 'expired'].includes(item.status))
  && (snapshot.supplementalInputs === undefined || Array.isArray(snapshot.supplementalInputs) && snapshot.supplementalInputs.length <= 64 && snapshot.supplementalInputs.every(item => object(item) && typeof item.id === 'string' && typeof item.text === 'string' && item.text.length <= 120_000 && typeof item.createdAt === 'string'))
  && ['nativeSessionId', 'nativeTurnId', 'nativeSessionRef', 'model', 'error'].every(key => snapshot[key] === undefined || typeof snapshot[key] === 'string' && snapshot[key].length <= (key === 'error' ? 4000 : 240));
const validMetadata = metadata => object(metadata)
  && (metadata.cwd === undefined || typeof metadata.cwd === 'string' && isAbsolute(metadata.cwd) && !/[\x00-\x1f\x7f]/.test(metadata.cwd))
  && (metadata.controls === undefined || object(metadata.controls) && Object.keys(metadata.controls).length <= 64 && Object.entries(metadata.controls).every(([id, input]) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && object(input) && /^[a-f0-9]{64}$/.test(input.signature) && ['pending', 'accepted', 'unknown'].includes(input.state) && (input.input === undefined || object(input.input) && input.input.id === id && typeof input.input.text === 'string' && input.input.text.length <= 120_000 && typeof input.input.createdAt === 'string') && (input.state !== 'accepted' || object(input.result) && input.result.accepted === true && typeof input.result.nativeTurnId === 'string' && input.result.nativeTurnId.length <= 240)));

// Execution owns this record. HTTP responses are disposable observers of its current snapshot.
export function createManagedRunStore({ directory, onFailure = () => {} }) {
  const records = new Map();
  const ledger = join(directory, 'seen');
  const ready = mkdir(ledger, { recursive: true, mode: 0o700 });
  const readJSON = async (file, maxBytes = 8_000_000) => {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw failure('run_read_failed', '原生运行记录格式无效；未覆盖原有记录。');
    return JSON.parse(await readFile(file, 'utf8'));
  };
  const receipt = async identity => {
    try {
      const value = await readJSON(join(ledger, `${keyOf(identity)}.json`), 4096);
      if (value.version !== 1 || !sameIdentity(value.identity, identity)) throw failure('run_read_failed', '原生请求登记无效；为避免重复执行，已拒绝重新提交。');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw failure('run_read_failed', '无法读取原生请求登记；为避免重复执行，已拒绝提交。'); }
  };
  const remember = async identity => {
    if (await receipt(identity)) return;
    const temporary = join(ledger, `${keyOf(identity)}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify({ version: 1, identity: Object.fromEntries(identityKeys.map(key => [key, identity[key]])), createdAt: Date.now() }), { mode: 0o600 });
    await rename(temporary, join(ledger, `${keyOf(identity)}.json`));
  };
  const persist = record => {
    clearTimeout(record.timer); record.timer = undefined;
    const value = JSON.stringify({ version: 1, identity: record.identity, metadata: record.metadata, snapshot: record.snapshot, updatedAt: Date.now() });
    if (Buffer.byteLength(value) > 8_000_000) return Promise.reject(failure('output_too_large', '原生回合快照超过大小限制，已保留此前内容。'));
    const temporary = join(directory, `${record.key}.${randomUUID()}.tmp`);
    record.saves = record.saves.catch(() => {}).then(async () => {
      await ready;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, join(directory, `${record.key}.json`));
    });
    return record.saves;
  };
  const envelope = (record, event) => ({ ...event, ...record.identity });
  const send = (record, observer, event) => {
    if (observer.res.destroyed || observer.res.writableEnded) { observer.detach(); return; }
    if (observer.res.writableLength > 1_000_000) { observer.res.destroy(); observer.detach(); return; }
    observer.res.write(`${JSON.stringify(envelope(record, event))}\n`);
  };
  const makeRecord = (identity, metadata, snapshot) => ({ key: keyOf(identity), identity: Object.fromEntries(identityKeys.map(key => [key, identity[key]])), metadata, snapshot, observers: new Set(), queue: Promise.resolve(), saves: Promise.resolve(), timer: undefined });
  const schedule = record => {
    if (record.timer) return;
    record.timer = setTimeout(() => {
      record.timer = undefined;
      record.queue.then(() => persist(record)).catch(error => onFailure(record, error));
    }, 150);
    record.timer.unref();
  };
  const publish = (record, event) => {
    const next = record.queue.then(async () => {
      const snapshot = record.snapshot;
      if (event.type === 'delta') {
        if (typeof event.text !== 'string' || snapshot.body.length + event.text.length > 1_000_000) throw failure('output_too_large', '原生回答超过大小限制，已保留此前内容。');
        snapshot.body += event.text;
      } else if (event.type === 'item') {
        if (!event.item || typeof event.item.id !== 'string' || typeof event.item.type !== 'string') return;
        if (Buffer.byteLength(JSON.stringify(event.item)) > 1_100_000) throw failure('output_too_large', '原生消息超过大小限制，已保留此前内容。');
        const index = snapshot.items.findIndex(item => item.id === event.item.id);
        if (index < 0 && snapshot.items.length >= 256) throw failure('output_too_large', '本轮原生事件超过大小限制，已保留此前内容。');
        if (index < 0) snapshot.items.push(event.item); else snapshot.items[index] = { ...snapshot.items[index], ...event.item };
        if (event.item.type === 'contextCompaction' && snapshot.state !== 'stopping') snapshot.state = event.item.status === 'running' ? 'compacting' : 'running';
      } else if (event.type === 'progress') {
        const index = event.id ? snapshot.events.findIndex(item => item.id === event.id) : -1;
        if (index < 0) snapshot.events = [...snapshot.events, event].slice(-100); else snapshot.events[index] = { ...snapshot.events[index], ...event };
      } else if (event.type === 'interaction') {
        if (snapshot.interactions.length >= 64 || Buffer.byteLength(JSON.stringify(event.interaction)) > 100_000) throw failure('output_too_large', '原生交互超过大小限制，已保留此前内容。');
        event = { ...event, interaction: { ...event.interaction, ...(event.interaction.afterItemId === undefined && snapshot.items.at(-1)?.id ? { afterItemId: snapshot.items.at(-1).id } : {}) } };
        snapshot.interactions.push(event.interaction);
        snapshot.state = 'waiting-input';
      } else if (event.type === 'interaction-resolved') {
        const interaction = snapshot.interactions.find(item => item.id === event.id);
        if (interaction) interaction.status = event.status;
        if (!snapshot.interactions.some(item => item.status === 'pending')) snapshot.state = 'running';
      } else if (event.type === 'user-input') {
        if (!snapshot.supplementalInputs) snapshot.supplementalInputs = [];
        if (!snapshot.supplementalInputs.some(item => item.id === event.input.id)) snapshot.supplementalInputs.push(event.input);
      } else if (event.type === 'session') {
        for (const key of ['nativeSessionId', 'nativeTurnId', 'nativeSessionRef', 'model']) if (typeof event[key] === 'string') snapshot[key] = event[key];
        if (snapshot.nativeTurnId) snapshot.delivery = 'accepted';
      } else if (event.type === 'state' && [...activeStates, ...terminal].includes(event.state)) {
        snapshot.state = event.state;
      } else if (event.type === 'done') {
        if (typeof event.body === 'string' && event.body.length > 1_000_000 || Array.isArray(event.items) && (event.items.length > 256 || Buffer.byteLength(JSON.stringify(event.items)) > 6_000_000)) throw failure('output_too_large', '原生结果超过大小限制，已保留此前内容。');
        for (const key of ['nativeSessionId', 'nativeTurnId', 'nativeSessionRef', 'model']) if (typeof event[key] === 'string') snapshot[key] = event[key];
        if (typeof event.body === 'string') snapshot.body = event.body;
        if (Array.isArray(event.items)) snapshot.items = event.items;
        snapshot.state = 'completed'; snapshot.delivery = snapshot.nativeTurnId ? 'accepted' : snapshot.delivery;
        delete snapshot.error;
      } else if (event.type === 'error') {
        if (typeof event.body === 'string' && event.body.length <= 1_000_000) snapshot.body = event.body;
        if (Array.isArray(event.items) && event.items.length <= 256 && Buffer.byteLength(JSON.stringify(event.items)) <= 6_000_000) snapshot.items = event.items;
        snapshot.state = event.state || (event.code === 'stopped' ? 'interrupted' : event.code === 'stop_unconfirmed' ? 'unknown' : 'failed');
        snapshot.error = event.error;
        if (snapshot.state === 'unknown' && snapshot.delivery !== 'accepted') snapshot.delivery = 'unknown';
      }
      if (terminal.has(snapshot.state)) for (const interaction of snapshot.interactions) if (interaction.status === 'pending') interaction.status = 'expired';
      snapshot.seq++;
      const output = { ...event, seq: snapshot.seq };
      if (['session', 'interaction', 'interaction-resolved', 'user-input', 'done', 'error', 'state'].includes(event.type)) await persist(record); else schedule(record);
      for (const observer of record.observers) send(record, observer, output);
      if (terminal.has(snapshot.state)) for (const observer of [...record.observers]) { observer.res.end(); observer.detach(); }
      return output;
    });
    record.queue = next.catch(() => {});
    return next;
  };
  return {
    async get(identity) {
      const key = keyOf(identity);
      if (records.has(key)) return records.get(key);
      await ready;
      let value;
      try { value = await readJSON(join(directory, `${key}.json`)); }
      catch (error) {
        if (error.code === 'ENOENT') {
          if (await receipt(identity)) throw Object.assign(new Error('此请求已经提交，完整恢复快照已过期；请读取原生历史，不能重复执行。'), { code: 'run_expired', status: 410 });
          return undefined;
        }
        throw failure('run_read_failed', '无法读取原生运行记录；请检查本机存储。');
      }
      if (value.version !== 1 || !sameIdentity(value.identity, identity) || !validSnapshot(value.snapshot) || !validMetadata(value.metadata)) throw failure('run_read_failed', '原生运行记录格式无效；未覆盖原有记录。');
      await remember(identity);
      const record = makeRecord(identity, value.metadata || {}, value.snapshot);
      if (activeStates.has(record.snapshot.state)) {
        record.snapshot.state = 'unknown'; if (record.snapshot.delivery !== 'accepted') record.snapshot.delivery = 'unknown';
        record.snapshot.error = '本机服务已重新启动，正在核对原生记录；请勿重复发送。';
        for (const item of record.snapshot.interactions) if (item.status === 'pending') item.status = 'expired';
        record.snapshot.seq++;
        await persist(record);
      }
      records.set(key, record); return record;
    },
    async create(identity, metadata = {}) {
      const existing = await this.get(identity);
      if (existing) return { record: existing, created: false };
      const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      if (files.length >= 256) {
        const candidates = [];
        for (const name of files) {
          const value = await readJSON(join(directory, name));
          if (!validIdentity(value.identity) || !validSnapshot(value.snapshot)) throw failure('run_read_failed', '原生运行记录格式无效；未覆盖原有记录。');
          if (['completed', 'failed', 'interrupted'].includes(value.snapshot?.state)) candidates.push({ name, identity: value.identity, time: value.updatedAt || 0 });
        }
        candidates.sort((left, right) => left.time - right.time);
        for (const old of candidates.slice(0, Math.max(0, files.length - 255))) { await remember(old.identity); records.delete(old.name.slice(0, -5)); await rm(join(directory, old.name), { force: true }); }
        if (files.length - candidates.length >= 512) throw failure('recovery_cache_full', '待核对的原生回合过多，请先恢复连接并核对已有记录。');
      }
      const record = makeRecord(identity, metadata, { type: 'snapshot', seq: 0, body: '', items: [], events: [], interactions: [], state: 'running', delivery: 'pending' });
      records.set(record.key, record);
      try { await remember(identity); await persist(record); }
      catch (error) { records.delete(record.key); throw error; }
      // Keep a finite recovery cache. Active and unresolved records are never silently evicted.
      const terminalRecords = [...records.values()].filter(item => item !== record && ['completed', 'failed', 'interrupted'].includes(item.snapshot.state));
      for (const old of terminalRecords.slice(0, Math.max(0, terminalRecords.length - 127))) { records.delete(old.key); await rm(join(directory, `${old.key}.json`), { force: true }); }
      return { record, created: true };
    },
    async unresolved(identity) {
      await ready;
      const files = (await readdir(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      for (const name of files) {
        const value = await readJSON(join(directory, name));
        if (!validIdentity(value.identity) || !validSnapshot(value.snapshot)) throw failure('run_read_failed', '原生运行记录格式无效；未覆盖原有记录。');
        if (!['workspaceId', 'researchId', 'conversationId', 'connectionId'].every(key => value.identity?.[key] === identity[key]) || value.identity.requestId === identity.requestId) continue;
        if (activeStates.has(value.snapshot?.state) || value.snapshot?.state === 'unknown') return this.get(value.identity);
      }
    },
    publish,
    async update(record, metadata) { Object.assign(record.metadata, metadata); await persist(record); },
    async observe(record, req, res) {
      await record.queue;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      if (record.observers.size >= 8) throw Object.assign(new Error('此原生回合的观察连接过多，请关闭重复窗口后重试。'), { status: 429, code: 'observer_limit' });
      let detach;
      const ended = new Promise(resolve => { detach = () => { record.observers.delete(observer); req.off('aborted', detach); res.off('close', detach); res.off('error', detach); resolve(); }; });
      const observer = { res, detach: () => detach() };
      req.once('aborted', detach); res.once('close', detach); res.once('error', detach);
      record.observers.add(observer);
      send(record, observer, { ...record.snapshot, type: 'snapshot' });
      if (terminal.has(record.snapshot.state)) { res.end(); detach(); }
      await ended;
    },
    async close() { await Promise.allSettled([...records.values()].map(async record => { await record.queue; await persist(record); for (const observer of [...record.observers]) { observer.res.end(); observer.detach(); } })); },
  };
}
