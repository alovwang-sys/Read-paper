import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureManualTag, expectedAssets, prepareAssets, updateDraft, verifySource } from './release.mjs';

export const REPOSITORY = 'alovwang-sys/Read-paper';
export const TAG = 'v0.1.9';
export const SOURCE = 'd882564d9a2a07552d59abbd4137f22d8112fee2';
export const BRANCH = 'codex/publish-v0.1.9';
const workflowPath = '.github/workflows/release.yml';
const artifactNames = Object.keys(expectedAssets(TAG)).map(target => `desktop-release-${target}`).sort();
const assetNames = [...Object.values(expectedAssets(TAG)).flat(), 'SHA256SUMS'].sort();
const digest = content => createHash('sha256').update(content).digest('hex');

export function requireConfiguredSource(source = SOURCE) {
  assert.match(source, /^[a-f0-9]{40}$/, 'SOURCE must be a full lowercase commit SHA');
  assert.notEqual(source, '0'.repeat(40), 'SOURCE placeholder must be replaced with the final merged main commit');
}

export async function requireFixedMain(api) {
  assert.equal((await api('/git/ref/heads/main')).object?.sha, SOURCE, 'Main changed; refusing this fixed-source release');
}

export function previewReleaseNotes(runId) {
  return `Papertrail ${TAG} · Codex 原生连续对话（未签名技术预览）\n\n` +
    `Source commit: ${SOURCE}\n\n` +
    '## 本版变化\n\n' +
    '- 同一个 Papertrail 对话保持同一个 Codex 原生线程；连续追问只发送新问题与新增或变化的材料，避免反复拼接完整旧问答。\n' +
    '- HTTP 断流或页面刷新后重新观察原回合；接收状态未知时核对原生记录，不自动重发。原生进程或服务退出后不保证运行继续。\n' +
    '- 右侧面板与原文小窗共用有序时间线，保留工具活动、待答复问题、审批与上下文整理状态；运行中可“补充本轮”，停止等待原生中断确认。\n' +
    '- 提交后清空已发送的输入，恢复或失败处理不会覆盖新草稿；原文小窗支持拖动标题移动、拖动右下角调整大小和方向键操作，移到右侧继续同一会话。\n' +
    '- 完整回答不会被截断的历史预览覆盖；较早记录按原生游标分页，保留旧回答与来源关联。\n\n' +
    '## 0.1.9 输入与恢复修复\n\n' +
    '- 修复受控复现的输入同步竞态：AI 文本框正在输入时，界面外部更新可能让草稿被旧状态覆盖。输入现在及时同步到最新状态，并保留原有草稿、会话状态和重启恢复的严格检查。\n' +
    '- 补强导航就绪与恢复测试，避免向尚未挂载完成的页面输入，恢复用例核对实际保存的数据。\n\n' +
    '## 下载与使用\n\n' +
    '- Mac Apple 芯片：`Papertrail-0.1.9-macos-arm64.dmg`；Intel Mac：`Papertrail-0.1.9-macos-x64.dmg`；Windows x64：`Papertrail-0.1.9-windows-x64-setup.exe`。Mac ZIP 为附加归档；Windows 配套 `.nupkg`、`RELEASES` 保持原名。\n' +
    '- 仍需在本机安装并登录 Codex。本版没有捆绑 Codex 引擎，没有独立账号登录界面，没有手动压缩按钮；不包含开发者模型凭据。\n' +
    '- 未配置 macOS Developer ID 签名 / Apple 公证（notarization）或 Windows 发行者签名，系统可能显示信任提示。`SHA256SUMS` 核对完整性，不替代发行者签名。完整附件共 8 个文件。\n' +
    '- 没有自动更新：退出应用后手动安装新版覆盖。升级前请在“设置 → 工作区备份与恢复”导出完整 ZIP；Markdown 不是全量备份。浏览器资料不会自动迁入桌面，跨设备也不同步；备份恢复为整库替换，不合并两边的新内容。\n\n' +
    '## 实际验证与边界\n\n' +
    '- 0.1.8 候选阶段的真实 Codex 探针验证三轮同线程续聊、主动断流后的原回合恢复，以及直接调用原生手动压缩后仍能回忆前文。该历史探针不代表 0.1.9 安装包重新验收。未触发自动阈值压缩；真实“补充本轮”、停止、审批及独立 Codex 桌面双向交接未由该探针验证。Intel / Windows 真实 Codex 调用尚未验证。\n' +
    '- 0.1.9 本机代码检查、业务单测、服务测试和桌面单测通过。真实模型探针与此前候选包的历史验证另见[验收记录](https://github.com/alovwang-sys/Read-paper/blob/v0.1.9/docs/verification/native-continuity/README.md)，历史结果不替代本次发行验证。\n' +
    '- macOS Intel 定向打包应用重复验证：[运行 #39240037338](https://github.com/alovwang-sys/Read-paper/actions/runs/39240037338) 对候选源 `e2905e914472a93f9d14c86d218a0131674ac4ba` 的原始 `inline-ai`、`native-session-recovery` 测试各重复 10 次，20/20 通过（约 2.6 分钟），未添加诊断埋点。生产代码及桌面测试源码已通过 diff 守卫核对一致；恢复用例保留关闭前 DOM/状态及重启后的严格断言。这是打包应用验证，不代表人工安装器验收。\n' +
    (runId ? `- 本次发行检查已完整通过，代码检查、浏览器 E2E 和三平台打包应用的具体结果见[发行运行 #${runId}](https://github.com/${REPOSITORY}/actions/runs/${runId})；本页附件固定到上述 Source commit。\n` : '') +
    '- 打包应用测试不等于安装器人工验收。本轮未完成 Intel / Windows 安装器、系统信任提示、干净环境及完整升级的全部人工检查；这是未签名技术预览，不能宣称稳定版验收通过。真正退出应用仍需停止并保存，没有新增常驻后台。\n';
}

export function selectDispatchedRun(runs, { baseline, workflowId, dispatchedAt }) {
  const matches = runs.filter(run => !baseline.has(run.id) && run.workflow_id === workflowId && run.path === workflowPath &&
    run.event === 'workflow_dispatch' && run.head_branch === 'main' && run.head_sha === SOURCE &&
    run.head_repository?.full_name === REPOSITORY && Date.parse(run.created_at) >= dispatchedAt);
  assert(matches.length <= 1, 'More than one new release run matches this dispatch; refusing to choose');
  return matches[0];
}

export function requireSuccessfulRun(run) {
  assert.equal(run.event, 'workflow_dispatch', 'Unexpected release run event');
  assert.equal(run.path, workflowPath, 'Unexpected release workflow');
  assert.equal(run.head_branch, 'main', 'Release must run from main');
  assert.equal(run.head_sha, SOURCE, 'Release run belongs to another source');
  assert.equal(run.head_repository?.full_name, REPOSITORY, 'Release run belongs to another repository');
  assert.equal(run.status, 'completed', 'Release workflow is still running');
  assert.equal(run.conclusion, 'success', 'Release workflow did not succeed');
}

export function requireRelease(release, expected, draft) {
  assert.equal(release.tag_name, TAG, 'Unexpected release tag');
  assert.equal(release.draft, draft, draft ? 'Release is no longer a draft' : 'Release is not public');
  assert.equal(release.prerelease, true, 'Release must remain an unsigned preview');
  const sources = release.body?.split('\n').filter(line => line.startsWith('Source commit: '));
  assert.deepEqual(sources, [`Source commit: ${SOURCE}`], 'Release belongs to a different or unknown source');
  assert.deepEqual(release.assets?.map(asset => asset.name).sort(), assetNames, 'Exactly eight release assets are required');
  for (const asset of release.assets) {
    assert(Number.isSafeInteger(asset.size) && asset.size > 0, `Invalid size for ${asset.name}`);
    assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/, `Missing SHA-256 for ${asset.name}`);
    const prepared = expected.find(item => item.name === asset.name);
    assert(prepared, `Unexpected asset ${asset.name}`);
    assert.equal(asset.digest, prepared.digest, `SHA-256 mismatch for ${asset.name}`);
    if (prepared.size !== undefined) assert.equal(asset.size, prepared.size, `Size mismatch for ${asset.name}`);
  }
}

async function requireTag(api) {
  let { object } = await api(`/git/ref/tags/${TAG}`);
  for (let depth = 0; object?.type === 'tag' && depth < 8; depth++) {
    assert.match(object.sha, /^[a-f0-9]{40}$/);
    ({ object } = await api(`/git/tags/${object.sha}`));
  }
  assert(object?.type === 'commit' && object.sha === SOURCE, 'Remote release tag does not match the fixed source');
}

export async function publishVerified({ api, runId, releaseId, expected }) {
  const run = await api(`/actions/runs/${runId}`);
  assert.equal(run.id, runId, 'Unexpected release run');
  requireSuccessfulRun(run);
  await requireTag(api);
  const release = await api(`/releases/${releaseId}`);
  requireRelease(release, expected, true);
  const body = previewReleaseNotes(runId);
  await requireFixedMain(api);
  const published = await api(`/releases/${releaseId}`, { method: 'PATCH', body: {
    draft: false, prerelease: true, tag_name: TAG, make_latest: 'false', body,
  } });
  assert.equal(published.id, releaseId, 'Unexpected published release');
  const current = await api(`/releases/${releaseId}`);
  requireRelease(current, expected, false);
  await requireTag(api);
  return current;
}

export async function verifyPublished({ api, release }) {
  await requireTag(api);
  const sums = release.assets?.find(asset => asset.name === 'SHA256SUMS');
  assert(sums?.id, 'Published release is missing checksums');
  const content = await api(`/releases/assets/${sums.id}`, { binary: true });
  const expected = [{ name: 'SHA256SUMS', digest: `sha256:${digest(content)}`, size: content.length }];
  for (const line of content.toString('utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match, 'Invalid published checksum manifest');
    expected.push({ name: match[2], digest: `sha256:${match[1]}` });
  }
  assert.deepEqual(expected.map(item => item.name).sort(), assetNames, 'Unexpected checksum manifest assets');
  requireRelease(await api(`/releases/${release.id}`), expected, false);
  await requireTag(api);
}

async function main() {
  requireConfiguredSource();
  assert.equal(process.env.GITHUB_REPOSITORY, REPOSITORY, 'Unexpected repository');
  assert.equal(process.env.GITHUB_REF, `refs/heads/${BRANCH}`, 'Unexpected publishing branch');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'Expected a branch push');
  const helperSha = process.env.GITHUB_SHA;
  assert.match(helperSha ?? '', /^[a-f0-9]{40}$/, 'Missing helper commit');
  const sourceDirectory = resolve('release-source');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, timeout: 120_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git(process.cwd(), 'rev-parse', 'HEAD'), helperSha, 'Publishing checkout changed');
  assert.equal(git(sourceDirectory, 'rev-parse', 'HEAD'), SOURCE, 'Release source checkout changed');
  const token = process.env.GH_TOKEN;
  assert(token, 'Missing Actions token');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(45_000) });
  const api = async (path, { method = 'GET', body, binary = false } = {}) => {
    const response = await request(`https://api.github.com/repos/${REPOSITORY}${path}`, {
      method, headers: { ...headers, 'Content-Type': 'application/json', ...(binary ? { Accept: 'application/octet-stream' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `GitHub ${method} ${path} failed (${response.status})`);
    return response.status === 204 ? null : binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  const list = async (path, key) => {
    const items = [];
    for (let page = 1; ; page++) {
      const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const entries = key ? result[key] : result;
      assert(Array.isArray(entries), 'Unexpected paginated GitHub response');
      items.push(...entries);
      if (entries.length < 100) return items;
    }
  };
  await requireFixedMain(api);
  let release = (await list('/releases')).find(item => item.tag_name === TAG);
  let run;
  const alreadyPublished = release && !release.draft;
  if (alreadyPublished) await verifyPublished({ api, release });
  else {
    await ensureManualTag({ tag: TAG, ref: 'refs/heads/main', sha: SOURCE, repository: REPOSITORY, token, cwd: sourceDirectory, request });
    git(sourceDirectory, 'fetch', 'origin', `refs/tags/${TAG}:refs/tags/${TAG}`);
    assert.equal(verifySource({ tag: TAG, event: 'workflow_dispatch', ref: 'refs/heads/main', eventSha: SOURCE, cwd: sourceDirectory }).sha, SOURCE);
    const workflow = await api('/actions/workflows/release.yml');
    assert.equal(workflow.path, workflowPath, 'Unexpected release workflow path');
    assert.equal(workflow.state, 'active', 'Release workflow is disabled');
    const runPath = `/actions/workflows/${workflow.id}/runs?event=workflow_dispatch&branch=main`;
    const baseline = new Set((await list(runPath, 'workflow_runs')).map(item => item.id));
    await requireFixedMain(api);
    const dispatchedAt = Math.floor(Date.now() / 1000) * 1000;
    await api(`/actions/workflows/${workflow.id}/dispatches`, { method: 'POST', body: { ref: 'main', inputs: { tag: TAG } } });
    const deadline = Date.now() + 75 * 60_000;
    while (Date.now() < deadline) {
      const candidate = selectDispatchedRun(await list(runPath, 'workflow_runs'), { baseline, workflowId: workflow.id, dispatchedAt });
      if (candidate) {
        if (run) assert.equal(candidate.id, run.id, 'Dispatched release run changed');
        else console.log(`Selected release workflow: https://github.com/${REPOSITORY}/actions/runs/${candidate.id}`);
        run = candidate;
        if (run.status === 'completed') { requireSuccessfulRun(run); break; }
      }
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
    assert(run?.status === 'completed', 'Timed out waiting for the dispatched release workflow');
    requireSuccessfulRun(run);
    const artifacts = await list(`/actions/runs/${run.id}/artifacts`, 'artifacts');
    assert.deepEqual(artifacts.map(item => item.name).sort(), artifactNames, 'Release run must contain exactly three platform artifacts');
    assert(artifacts.every(item => !item.expired && item.workflow_run?.id === run.id && item.workflow_run?.head_sha === SOURCE), 'Release artifacts expired or belong to another run');
    console.log(`Verified successful release workflow ${run.id} and three complete platform artifacts`);
    const temporary = mkdtempSync(join(tmpdir(), 'papertrail-v019-'));
    try {
      const downloaded = join(temporary, 'download');
      const staged = join(temporary, 'assets');
      execFileSync('gh', ['run', 'download', String(run.id), '--repo', REPOSITORY, '--pattern', 'desktop-release-*', '--dir', downloaded], {
        timeout: 10 * 60_000, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
      });
      const names = prepareAssets(downloaded, staged, TAG);
      const expected = names.map(name => {
        const content = readFileSync(join(staged, name));
        return { name, size: content.length, digest: `sha256:${digest(content)}` };
      });
      console.log(`Prepared and hashed ${expected.length} release assets from workflow ${run.id}`);
      await updateDraft({ tag: TAG, sha: SOURCE, repository: REPOSITORY, token, directory: staged, request });
      release = (await list('/releases')).find(item => item.tag_name === TAG);
      assert(release, 'Missing prepared release draft');
      console.log(`Verifying draft ${release.id} before publishing ${TAG} at ${SOURCE}`);
      release = await publishVerified({ api, runId: run.id, releaseId: release.id, expected });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  const summary = `Published unsigned preview: ${release.html_url}\n\nSource commit: ${SOURCE}\n\n${run ? `Release workflow: https://github.com/${REPOSITORY}/actions/runs/${run.id}` : 'Existing published release verified without modification.'}\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
  const retained = `Temporary branch ${BRANCH} retained for review; main was not modified.${alreadyPublished ? ' No remote changes made.' : ''}`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${retained}\n`);
  console.log(retained);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
