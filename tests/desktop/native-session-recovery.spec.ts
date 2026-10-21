import { useClassicWorkbench } from './helpers';
import { expect, test, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createSeed } from '../../src/data/seed';
import type { ContextSnapshot, WorkspaceData } from '../../src/domain/types';
import { fixtureSessionRef, mockProjectService } from '../e2e/project-fixture';
import { openSource } from '../e2e/knowledge-helpers';

const packageRoot = resolve(`out/Papertrail-${process.platform}-${process.arch}`);
const executablePath = process.env.PAPERTRAIL_EXECUTABLE || (process.platform === 'darwin'
  ? join(packageRoot, 'Papertrail.app/Contents/MacOS/Papertrail') : join(packageRoot, 'Papertrail.exe'));
const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');
const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-status', 'saved');
const oldSessionId = 'desktop-original-session', newSessionId = oldSessionId;

async function state(page: Page): Promise<WorkspaceData> {
  return page.evaluate(async () => {
    const recovery = localStorage.getItem('papertrail-recovery-v3');
    if (recovery) return JSON.parse(recovery);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('papertrail', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<WorkspaceData>((resolve, reject) => {
        const request = db.transaction('workspace').objectStore('workspace').get('current');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  });
}

async function launch(userData: string, home: string) {
  const application = await _electron.launch({ executablePath, env: {
    ...process.env, PAPERTRAIL_USER_DATA: userData, HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_CONFIG_DIR: join(home, '.opencode'), OPENCODE_CONFIG: '', OPENCODE_CONFIG_CONTENT: '',
    AI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
  }, timeout: 60_000 });
  try {
    const page = await application.firstWindow(); await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('main', { name: '主工作区' })).toBeVisible(); await useClassicWorkbench(page); await saved(page);
    return { application, page };
  } catch (error) { const exited = application.waitForEvent('close'); application.process().kill(); await exited; throw error; }
}
async function close(application: ElectronApplication) {
  const exited = application.waitForEvent('close');
  void application.evaluate(({ app }) => app.quit()).catch(() => {}); await exited;
}

// Packaged assets and persistence are real; only the native service responses use a deterministic fixture.
test('打包桌面：连续会话沿用原生线程，旧来源不变且重启保留同一身份和累计材料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'papertrail-desktop-recovery-'));
  const userData = join(directory, 'app-data'), home = join(directory, 'isolated-home');
  await Promise.all([mkdir(userData), mkdir(home)]);
  let application: ElectronApplication | undefined;
  const requests: { requestId: string; sessionRef: string; prompt: string; managed: boolean; history: unknown[]; reset: boolean }[] = [], pageErrors: string[] = [];
  let modelCalls = 0;
  try {
    const seed = createSeed(), conversationId = 'conversation-research-a';
    for (const document of Object.values(seed.documents)) if (document.sampleUrl) {
      document.hash = createHash('sha256').update(await readFile(`public${document.sampleUrl}`)).digest('hex');
    }
    const snapshot = (id: string): ContextSnapshot => {
      const evidence = seed.evidence[id], document = seed.documents[evidence.documentId];
      return { evidenceId: id, documentId: document.id, documentHash: document.hash!, title: document.title, pageIndex: evidence.pageIndex, quote: evidence.quote };
    };
    const context = [snapshot('evidence-a'), snapshot('evidence-b')];
    Object.assign(seed.conversations[conversationId], {
      connectionId: 'codex', nativeSessionId: oldSessionId, nativeSessionRef: fixtureSessionRef(oldSessionId),
      nativeState: 'idle', nativeCanResume: true, title: '桌面会话恢复验证', requestIds: ['old-request'],
      contextIds: ['evidence-c'], sentContext: context,
    });
    seed.requests['old-request'] = { id: 'old-request', researchId: 'research-a', conversationId,
      connectionId: 'codex', nativeSessionId: oldSessionId, prompt: '先前的检索问题。',
      body: '旧回答：证据相关性需要核查。 [1]', context, evidenceIds: ['evidence-a'], status: 'done',
      purpose: 'chat', mode: 'live', createdAt: '2026-10-17T01:00:00.000Z', history: [],
    };
    let session = await launch(userData, home); application = session.application; let page = session.page;
    page.on('pageerror', error => pageErrors.push(error.message)); expect(page.url()).toBe('papertrail://app/');
    await mockProjectService(page, { seed });
    await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: 'fixture', provider: 'fixture', mode: 'live', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
    await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [{ id: 'codex', name: 'Codex', state: 'ready', capabilities: { images: false, tools: true, resume: true, permissions: 'read-only' } }] } }));
    await page.route('**/api/ai/agents/codex/capabilities', route => route.fulfill({ json: { models: [], skills: [], plan: false, accessModes: ['read-only'] } }));
    await page.route('**/api/ai/chat', route => { modelCalls++; return route.fulfill({ status: 500, body: 'Unexpected fallback' }); });
    await page.route('**/api/ai/agents/run', route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ contentType: 'application/x-ndjson', body: [
        { type: 'session', seq: 1, nativeSessionId: newSessionId, nativeSessionRef: fixtureSessionRef(newSessionId), nativeTurnId: 'desktop-turn-2' },
        { type: 'delta', seq: 2, text: '桌面模拟恢复回答：已保留历史与来源。 [1]' },
        { type: 'done', seq: 3, body: '桌面模拟恢复回答：已保留历史与来源。 [1]', model: '桌面模拟运行时', nativeSessionId: newSessionId, nativeSessionRef: fixtureSessionRef(newSessionId), nativeTurnId: 'desktop-turn-2' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n' });
    });
    await page.reload(); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
    await openSource(page, 'Retrieval Baselines & Trade-offs');
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
    await expect(page.getByRole('main').locator('.pdf-page-loading')).toHaveCount(0);
    await openSource(page, 'Adaptive Retrieval: Evidence & Reliability');
    await expect(page.getByRole('main').locator('canvas').first()).toBeVisible();
    const original = (await state(page)).requests['old-request'];
    await input(page).fill('桌面继续核对原研究的证据条件。');
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click();
    await expect(panel(page).locator('.ai-answer').last()).toContainText('桌面模拟恢复回答');
    await expect(panel(page).getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0);
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ sessionRef: fixtureSessionRef(oldSessionId), managed: true, history: [], reset: false });
    const draft = '桌面恢复后尚未发送的下一条问题。'; await input(page).fill(draft);
    await expect(input(page)).toHaveValue(draft); await saved(page);
    const data = await state(page);
    expect(data.conversations[conversationId].input).toBe(draft);
    expect(data.requests['old-request']).toEqual(original);
    expect(data.requests[requests[0].requestId].nativeSessionId).toBe(newSessionId);
    expect(data.requests[requests[0].requestId].nativeTurnId).toBe('desktop-turn-2');
    expect(data.conversations[conversationId].nativeSessionRef).toBe(fixtureSessionRef(newSessionId));
    expect(data.conversations[conversationId].sentContext?.map(item => item.evidenceId).sort()).toEqual(['evidence-a', 'evidence-b', 'evidence-c']);
    await page.screenshot({ path: test.info().outputPath('desktop-session-recovery.png') });
    await close(application); application = undefined;
    session = await launch(userData, home); application = session.application; page = session.page;
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(input(page)).toHaveValue(draft);
    expect((await state(page)).conversations[conversationId].input).toBe(draft);
    await mockProjectService(page, { initializeWorkspace: false });
    // A restarted renderer must restore persisted data even without a fixture session marker.
    await page.evaluate(() => sessionStorage.removeItem('papertrail-project-fixture-ready'));
    await page.reload();
    await expect(input(page)).toHaveValue(draft);
    const restored = await state(page);
    expect(restored.conversations[conversationId].input).toBe(draft);
    expect(restored.requests['old-request']).toEqual(original);
    expect(restored.conversations[conversationId].nativeSessionRef).toBe(fixtureSessionRef(newSessionId));
    expect(restored.conversations[conversationId].sentContext).toEqual(data.conversations[conversationId].sentContext);
    expect(requests).toHaveLength(1); expect(modelCalls).toBe(0); expect(pageErrors).toEqual([]);
    await writeFile(test.info().outputPath('desktop-session-recovery.json'), JSON.stringify({ executablePath,
      protocol: 'papertrail://app/', requestCount: requests.length, actualModelCalls: 0, oldMessagesUnchanged: true,
      historyScopeRetained: true, sameNativeReferenceRetainedAfterRestart: true, nextDraftRetained: true, pageErrors,
    }, null, 2) + '\n');
  } finally {
    const appProcess = application?.process();
    try { if (application) await close(application); }
    finally {
      if (appProcess?.exitCode === null) appProcess.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
});
