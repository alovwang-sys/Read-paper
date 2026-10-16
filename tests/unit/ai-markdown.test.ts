import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../../src/features/ai/MarkdownContent';

const render = (text: string) =>
  renderToStaticMarkup(createElement(MarkdownContent, { text }));

describe('AI 回答安全呈现', () => {
  it('呈现 Markdown 表格、代码与公式', () => {
    const html = render(
      '| 条件 | 结论 |\n| --- | --- |\n| 相关 | 有效 |\n\n`source` 与 $x^2$',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<code>source</code>');
    expect(html).toContain('class="katex"');
  });

  it('不执行原始 HTML、不加载模型给出的远程图片或危险链接', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src="https://example.com/pixel" />\n\n![图](https://example.com/tracker.png)\n\n[危险](javascript:alert%281%29)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('tracker.png');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('[图片：图]');
  });

  it('无效公式保留可读的原公式，并保护外部链接', () => {
    const html = render('$\\unknowncommand{x}$\n\n[文档](https://example.com)');
    expect(html).toContain('unknowncommand');
    expect(html).toContain('noopener noreferrer');
  });
});
