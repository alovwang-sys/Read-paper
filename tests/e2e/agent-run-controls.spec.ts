import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { chat, composer, installControlledServices, openSeedPaper, readData, saved } from '../../docs/verification/continuous-workspace/harness';

test.use({ storageState: { cookies: [], origins: [] } });

const shots = 'docs/verification/agent-connections/screenshots';
// Shapes mirror what each CLI's own menu returned on the development machine; no real model is called.
const codexModels = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low', images: true },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', images: true },
];
const claudeModels = [
  { id: 'default', name: 'Default (recommended)', isDefault: true, description: 'Use the default model (currently Opus 5.5)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'sonnet', name: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'haiku', name: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers', efforts: ['low', 'medium', 'high'] },
];

async function install(page: Page) {
  const fixture = await installControlledServices(page);
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [
    { id: 'codex', research: true, images: true, state: 'ready', detail: '受控验收连接，未调用真实模型', modes: ['auto', 'plan', 'offline'], web: true, configuredEffort: 'high', models: codexModels },
    { id: 'claude', research: true, images: false, state: 'ready', detail: '受控验收连接；随问附送原文', modes: ['auto', 'plan', 'offline'], web: true, models: claudeModels },
    { id: 'demo', research: true, images: false, state: 'ready', detail: '固定演示流程', modes: ['auto', 'plan'], web: false },
  ] } }));
  return fixture;
}
const modelChip = (page: Page) => chat(page).getByRole('button', { name: '选择模型与思考程度', exact: true });
const modeChip = (page: Page) => chat(page).getByRole('button', { name: /^研究模式：/ });
async function useAgent(page: Page, name: string) {
  await chat(page).getByRole('button', { name: '选择研究助手', exact: true }).click();
  await chat(page).getByRole('listbox', { name: '研究 Agent 连接' }).getByRole('option', { name, exact: true }).click();
}
async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await chat(page).getByRole('button', { name: '开始研究', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
}

test('输入区像原生 CLI 一样选模型、思考程度和模式，按助手记住并随每轮发送', async ({ page }) => {
  const fixture = await install(page);
  await page.goto('/'); await openSeedPaper(page);
  await mkdir(shots, { recursive: true });

  // Without a pick the composer shows what config.toml selects today.
  await expect(modelChip(page)).toHaveText('GPT-6.1-Sol · 高');
  await expect(modeChip(page)).toHaveAccessibleName('研究模式：自动');
  await modelChip(page).click();
  const menu = chat(page).getByRole('dialog', { name: '模型与思考程度' });
  await menu.getByRole('option', { name: 'GPT-6-Luna', exact: true }).click();
  await expect(modelChip(page)).toHaveText('GPT-6-Luna · 中');
  await menu.getByRole('radio', { name: '超高', exact: true }).click();
  await expect(modelChip(page)).toHaveText('GPT-6-Luna · 超高');
  await expect(menu.getByRole('radio', { name: '极限' })).toHaveCount(0);
  await saved(page); await page.screenshot({ path: `${shots}/run-model-menu-1440.png` });
  await menu.getByRole('button', { name: '关闭模型选择' }).click();

  // Shift+Tab cycles the conversation's mode, as in the CLI.
  await composer(page).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(modeChip(page)).toHaveAccessibleName('研究模式：规划');
  await expect(composer(page)).toBeFocused();
  await send(page, '先规划怎么比较这两类检索方法。');
  await expect.poll(() => fixture.researchCalls.length).toBe(1);
  expect(fixture.researchCalls[0].settings).toEqual({ model: 'gpt-6-luna', effort: 'xhigh', mode: 'plan' });
  await expect(chat(page).locator('.research-agent-run-meta').last()).toHaveText('controlled-continuous · 超高 · 规划');

  // Claude Code keeps its own pick; the conversation keeps its mode.
  await useAgent(page, 'Claude Code');
  await expect(modelChip(page)).toHaveText('默认模型');
  await expect(modeChip(page)).toHaveAccessibleName('研究模式：规划');
  await modelChip(page).click();
  await menu.getByRole('option', { name: 'Sonnet', exact: true }).click();
  await menu.getByRole('radio', { name: '高', exact: true }).click();
  await expect(modelChip(page)).toHaveText('Sonnet · 高');
  await saved(page); await page.screenshot({ path: `${shots}/run-claude-menu-1440.png` });
  await menu.getByRole('button', { name: '关闭模型选择' }).click();
  await modeChip(page).click();
  const modes = chat(page).getByRole('dialog', { name: '研究模式' });
  await expect(modes.getByRole('option')).toHaveText([/自动.*联网检索/, /规划/, /仅资料.*不联网/]);
  await modes.getByRole('option', { name: '自动', exact: true }).click();
  await send(page, '用最新资料补充背景。');
  await expect.poll(() => fixture.researchCalls.length).toBe(2);
  expect(fixture.researchCalls[1].settings).toEqual({ model: 'sonnet', effort: 'high', mode: 'auto' });

  await useAgent(page, 'Codex');
  await expect(modelChip(page)).toHaveText('GPT-6-Luna · 超高');
  // Demo has no model menu and no web, so it offers only auto and plan.
  await useAgent(page, '演示模式');
  await expect(modelChip(page)).toHaveCount(0);
  await modeChip(page).click();
  await expect(chat(page).getByRole('dialog', { name: '研究模式' }).getByRole('option')).toHaveText([/自动/, /规划/]);
  await chat(page).getByRole('button', { name: '关闭模式选择' }).click();
  await useAgent(page, 'Codex');

  const data = await readData(page);
  expect(data.agentRunSettings).toEqual({ codex: { model: 'gpt-6-luna', effort: 'xhigh' }, claude: { model: 'sonnet', effort: 'high' } });
  expect(data.requests[fixture.researchCalls[0].requestId].runSettings).toEqual({ model: 'gpt-6-luna', effort: 'xhigh', mode: 'plan' });
  await saved(page); await page.reload(); await openSeedPaper(page);
  await expect(modelChip(page)).toHaveText('GPT-6-Luna · 超高');

  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 800]]) {
    await page.setViewportSize({ width, height });
    for (const control of [modelChip(page), modeChip(page), chat(page).getByRole('button', { name: '开始研究', exact: true })]) await expect(control).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await saved(page); await page.screenshot({ path: `${shots}/run-controls-${width}.png` });
  }
  fixture.assertClean();
});

test('兼容性自检的结果显示在助手列表里：一致时说明已核对，CLI 改动后标“需适配”并写明影响', async ({ page }) => {
  const fixture = await install(page);
  const claudeWarning = '此版本的 Claude Code 没有 WebSearch 工具（可能已改名），本轮无法联网检索；需要更新本应用的适配。';
  await page.route('**/api/ai/research/capabilities', route => route.fulfill({ json: { connections: [
    { id: 'codex', research: true, images: true, state: 'ready', version: '0.165.0', detail: '受控验收连接，未调用真实模型', modes: ['auto', 'plan', 'offline'], web: true, models: codexModels, selfCheck: { checked: 27, warnings: [] } },
    { id: 'claude', research: true, images: false, state: 'ready', version: '2.1.316', detail: '受控验收连接；随问附送原文', modes: ['auto', 'plan', 'offline'], web: true, models: claudeModels, selfCheck: { checked: 16, warnings: [claudeWarning] } },
    { id: 'demo', research: true, images: false, state: 'ready', detail: '固定演示流程', modes: ['auto', 'plan'], web: false },
  ] } }));
  await page.goto('/'); await openSeedPaper(page);
  await mkdir(shots, { recursive: true });
  const agentButton = chat(page).getByRole('button', { name: '选择研究助手', exact: true });
  await expect(agentButton.locator('.research-agent-connection-dot')).toHaveClass(/is-ready/);
  await agentButton.click();
  const picker = chat(page).getByRole('dialog', { name: '选择研究助手' });
  await expect(picker.locator('.research-agent-config-check')).toHaveText('兼容性自检：已核对 27 项，与本机 Codex 0.165.0 一致。');
  const claude = picker.getByRole('option', { name: 'Claude Code', exact: true });
  await expect(claude).toContainText('需适配');
  await expect(claude).toHaveAccessibleDescription(claudeWarning);
  await expect(claude.locator('.research-agent-connection-dot')).toHaveClass(/is-warning/);
  await saved(page); await page.screenshot({ path: `${shots}/self-check-picker-1440.png` });

  // Still usable: a changed CLI is flagged, not blocked; the composer dot and tooltip carry the finding.
  await claude.click();
  await expect(agentButton.locator('.research-agent-connection-dot')).toHaveClass(/is-warning/);
  await expect(agentButton).toHaveAttribute('title', new RegExp(`兼容性自检：${claudeWarning}`));
  await agentButton.click();
  await expect(picker.locator('.research-agent-config-check')).toHaveText('兼容性自检：已核对 16 项，发现 1 处需要适配。');
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(picker.locator('.research-agent-config-check')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await saved(page); await page.screenshot({ path: `${shots}/self-check-picker-1024.png` });
  await picker.getByRole('button', { name: '关闭 Agent 配置' }).click();
  await send(page, '用最新资料补充背景。');
  await expect.poll(() => fixture.researchCalls.length).toBe(1);
  expect(fixture.researchCalls[0].connectionId).toBe('claude');
  fixture.assertClean();
});
