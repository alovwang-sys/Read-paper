import { expect, test, type Page } from '@playwright/test';
import { mockProjectService } from './project-fixture';

const panel = (page: Page) => page.getByRole('complementary', { name: '参考面板' });
const input = (page: Page) => panel(page).getByLabel('向 AI 提问');

async function start(page: Page) {
  await mockProjectService(page);
  await page.route('**/api/ai/config', route => route.fulfill({ json: { configured: false, images: false, model: '模拟连接', limits: { maxInputChars: 120000, maxImages: 4, maxImageBytes: 8388608 } } }));
  await page.route('**/api/ai/agents', route => route.fulfill({ json: { agents: [] } }));
  await page.goto('/'); await panel(page).getByRole('tab', { name: 'AI', exact: true }).click();
  await input(page).fill('语音输入之前的草稿');
}

test('浏览器语音入口显示系统听写引导，保留草稿且不发送或请求录音', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (/\/api\/ai\/(?:chat|agents\/run)$/.test(new URL(request.url()).pathname)) requests.push(request.url()); });
  await start(page);
  await page.evaluate(() => {
    if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('Must not request microphone'); };
  });
  const voice = panel(page).getByRole('button', { name: '语音输入', exact: true });
  await expect(voice).toHaveText('语音'); await voice.click();
  await expect(panel(page).locator('.ai-voice-hint')).toContainText('使用系统听写');
  await expect(panel(page).locator('.ai-voice-hint')).toContainText('识别文字留在草稿，不自动发送');
  await expect(panel(page).locator('.ai-voice-hint')).not.toContainText('已请求系统听写');
  await expect(input(page)).toBeFocused(); await input(page).press('Escape');
  await expect(panel(page).locator('.ai-voice-hint')).toHaveCount(0);
  await expect(input(page)).toHaveValue('语音输入之前的草稿'); expect(requests).toEqual([]);
});

for (const result of ['requested', 'unavailable', 'error']) test(`桌面听写桥接${result}时诚实反馈并保留输入`, async ({ page }) => {
  await start(page);
  await page.evaluate(result => {
    Reflect.set(window, '__dictationCalls', 0);
    Object.defineProperty(window, 'papertrailDesktop', { configurable: true, value: { startDictation: async () => {
      if (document.activeElement?.getAttribute('aria-label') !== '向 AI 提问') throw new Error('Text input must be focused first');
      Reflect.set(window, '__dictationCalls', Number(Reflect.get(window, '__dictationCalls')) + 1);
      if (result === 'error') throw new Error('模拟：系统听写未能启动');
      return result === 'requested';
    } } });
  }, result);
  await panel(page).getByRole('button', { name: '语音输入', exact: true }).click();
  const hint = panel(page).locator('.ai-voice-hint');
  if (result === 'requested') await expect(hint).toContainText('已请求系统听写');
  else if (result === 'error') await expect(hint).toContainText('模拟：系统听写未能启动');
  else await expect(hint).not.toContainText('已请求系统听写');
  await expect(hint).toContainText('识别文字留在草稿，不自动发送');
  expect(await page.evaluate(() => Reflect.get(window, '__dictationCalls'))).toBe(1);
  await expect(input(page)).toHaveValue('语音输入之前的草稿');
});
