import { describe, expect, it } from 'vitest';
import { createSeed } from '../../src/data/seed';
import { migrateWorkspace } from '../../src/data/migrations';
import { effectiveRunSettings } from '../../src/services/research-agent';
import type { ResearchAgentCapability } from '../../src/domain/research-agent';

const codex: ResearchAgentCapability = { id: 'codex', research: true, detail: '', modes: ['auto', 'plan', 'offline'], web: true, configuredEffort: 'high', models: [
  { id: 'gpt-a', name: 'A', isDefault: true, efforts: ['low', 'high'] },
  { id: 'gpt-b', name: 'B', efforts: ['medium'] },
] };

describe('助手模型、思考程度与模式', () => {
  it('只发送当前助手仍提供的选择，失效项回到原生默认', () => {
    const data = createSeed();
    const conversation = data.conversations['conversation-research-a'];
    data.agentRunSettings = { codex: { model: 'gpt-b', effort: 'medium' } };
    expect(effectiveRunSettings(data, 'codex', { ...conversation, agentMode: 'plan' }, codex)).toMatchObject({ model: 'gpt-b', effort: 'medium', mode: 'plan' });
    data.agentRunSettings = { codex: { model: 'gone', effort: 'high' } };
    expect(effectiveRunSettings(data, 'codex', conversation, codex)).toMatchObject({ effort: 'high', mode: 'auto' });
    expect(effectiveRunSettings(data, 'codex', conversation, codex).model).toBeUndefined();
    data.agentRunSettings = { codex: { model: 'gpt-a' }, demo: { model: 'x' } };
    expect(effectiveRunSettings(data, 'codex', conversation, codex).model).toBeUndefined();
    expect(effectiveRunSettings(data, 'demo', { ...conversation, agentMode: 'offline' }, { id: 'demo', research: true, detail: '', modes: ['auto', 'plan'] })).toEqual({ mode: 'auto', target: undefined });
  });

  it('持久化只接受已知助手、安全的模型名与模式', () => {
    const valid = createSeed();
    valid.agentRunSettings = { codex: { model: 'gpt-6.1-sol', effort: 'xhigh' }, claude: { model: 'claude-fable-5-1[1m]' } };
    valid.conversations['conversation-research-a'].agentMode = 'offline';
    expect(migrateWorkspace(valid).agentRunSettings).toEqual(valid.agentRunSettings);
    for (const broken of [{ unknown: {} }, { codex: { model: 'a b' } }, { codex: { effort: 'High' } }, { codex: { mode: 'plan' } }]) {
      const data = createSeed(); data.agentRunSettings = broken as never;
      expect(() => migrateWorkspace(data)).toThrow('助手模型设置损坏');
    }
    const mode = createSeed(); (mode.conversations['conversation-research-a'] as { agentMode?: string }).agentMode = 'yolo';
    expect(() => migrateWorkspace(mode)).toThrow('助手模式损坏');
  });
});
