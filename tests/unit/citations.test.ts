import { describe, expect, it } from 'vitest';
import { mapCitationNumbers, remapCitationNumbers } from '../../src/domain/citations';

describe('Markdown 中的来源编号', () => {
  it('重映射正文引用，保留代码中的数组和数字示例', () => {
    const body = '依据 [2]。`items[0]`\n```js\nconst value = [99];\n```\n后续 [1]';
    expect(remapCitationNumbers(body, ['a', 'b'], ['b', 'a'])).toBe('依据 [1]。`items[0]`\n```js\nconst value = [99];\n```\n后续 [2]');
  });
  it('人工摘录只移除正文引用，未闭合的代码块仍按字面保留', () => {
    expect(mapCitationNumbers('未完成回答 [99]，示例 `a[0]`\n~~~\n[1]', () => '')).toBe('未完成回答 ，示例 `a[0]`\n~~~\n[1]');
  });
  it('代码之外的非法引用仍阻止保存', () => {
    expect(() => remapCitationNumbers('依据 [0]', ['a'], ['a'])).toThrow(/引用/);
  });
  it('公式内部的数字下标不充当来源，公式之后的引用仍会重编号', () => {
    expect(remapCitationNumbers('$x[0]$ 和 $$y[99]$$，依据 [2]', ['a', 'b'], ['b', 'a'])).toBe('$x[0]$ 和 $$y[99]$$，依据 [1]');
  });
});
