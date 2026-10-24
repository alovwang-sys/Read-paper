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
  it('TeX 行内分隔符保护数字下标，公式前后的引用正常重编号', () => {
    const body = String.raw`依据 [2]，\(x[0] + y[99]\)，后续 [1]`;
    expect(remapCitationNumbers(body, ['a', 'b'], ['b', 'a'])).toBe(String.raw`依据 [1]，\(x[0] + y[99]\)，后续 [2]`);
  });
  it('TeX 块公式跨行保留数字下标，与其他公式和代码规则共存', () => {
    const body = String.raw`\[
x[0] + y[99]
\]，$z[0]$，\(a[99]\)，` + '`items[0]`，依据 [2]';
    expect(remapCitationNumbers(body, ['a', 'b'], ['b', 'a'])).toBe(body.replace('依据 [2]', '依据 [1]'));
  });
  it.each([String.raw`\\(literal [99]\\)，依据 [1]`, String.raw`\\[literal [99]\\]，依据 [1]`])('双反斜杠为字面转义，不豁免无效引用：%s', body => {
    expect(() => remapCitationNumbers(body, ['a'], ['a'])).toThrow(/引用 \[99\]/);
  });
  it.each([String.raw`\\\(x[0] + y[99]\\\)，依据 [2]`, String.raw`\\\[x[0] + y[99]\\\]，依据 [2]`])('三个反斜杠保留字面前缀，第三个开启真实公式：%s', body => {
    expect(remapCitationNumbers(body, ['a', 'b'], ['b', 'a'])).toBe(body.replace('依据 [2]', '依据 [1]'));
  });
  it.each([String.raw`\(x[0]`, String.raw`\[x[99]`, '(x[0])', String.raw`\(x[0]\)，依据 [99]`])('未闭合或非显式公式、公式外非法引用仍阻止保存：%s', body => {
    expect(() => remapCitationNumbers(body, ['a'], ['a'])).toThrow(/引用/);
  });
  it('数字 Markdown 链接及链接定义不是论文引用', () => {
    const body = '链接 [1](https://example.com/source) 和 [2][reference]，论文 [2]\n[3]: https://example.com';
    expect(remapCitationNumbers(body, ['a', 'b'], ['b', 'a'])).toBe('链接 [1](https://example.com/source) 和 [2][reference]，论文 [1]\n[3]: https://example.com');
  });
});
