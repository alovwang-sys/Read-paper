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

  it('呈现截图中的 TeX 行内比值和大于条件，保留公式外的引用入口', () => {
    const text = String.raw`重要性权重 \(\frac{\pi_{\mathrm{tar}}(z)}{\pi_{\mathrm{beh}}(z)}\)，条件 \(N\gg1\)。GRPO 比值 \(\frac{\pi_\theta(y_{i,t}\mid\cdot)}{\pi_{\theta_{\mathrm{old}}}(y_{i,t}\mid\cdot)}\)。来源 [1]`;
    const html = renderToStaticMarkup(createElement(MarkdownContent, { text, onCitation: () => {} }));
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html).toContain('class="mfrac"');
    expect(html).toContain('citation-link');
    expect(html).not.toContain('katex-error');
  });

  it('支持 TeX 块公式和原有美元公式，数学下标不变成来源按钮', () => {
    const text = String.raw`正文 \[x_{[99]}=\frac{a}{b}\] 然后 $y^2$，原有块式：
$$
z=x+y
$$
来源 [1]`;
    const html = renderToStaticMarkup(createElement(MarkdownContent, { text, onCitation: () => {} }));
    expect(html.match(/class="katex"/g)).toHaveLength(3);
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html.match(/citation-link/g)).toHaveLength(1);
    expect(html).not.toContain('katex-error');
  });

  it('代码、链接、转义与未闭合 TeX 不误转数学，普通括号仍是文字', () => {
    const text = '代码 `\\(x\\)`，' + String.raw`链接 [说明](https://example.com/\(literal\))；费用 \$5，公式 \(x^2\)，普通 (N≫1)。未闭合 \(x_1`;
    const html = render(text);
    expect(html).toContain('<code>\\(x\\)</code>');
    expect(html).toContain('href="https://example.com/(literal)"');
    expect(html).toContain('$5');
    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html).toContain('(N≫1)');
    expect(html).toContain('(x_1');
  });

  it('围栏代码、反引号代码与已有公式不被递归改写', () => {
    const html = render('````text\n\\(x_1\\)\n```\n\\[y_1\\]\n````\n\n``\\(z_1\\)``\n\n$\\text{literal \\(x\\)}$');
    expect(html).toContain('\\(x_1\\)');
    expect(html).toContain('\\[y_1\\]');
    expect(html).toContain('<code>\\(z_1\\)</code>');
    expect(html.match(/class="katex"/g)).toHaveLength(1);
  });

  it('列表和引用中的块公式留在各自容器内', () => {
    const html = render('1. 条件：\n   \\[x^2\\]\n2. 下一项\n\n> 条件 \\[y^2\\] 后续');
    expect(html.match(/class="katex-display"/g)).toHaveLength(2);
    expect(html).toMatch(/<li>[\s\S]*katex-display[\s\S]*<\/li>/);
    expect(html).toMatch(/<blockquote>[\s\S]*katex-display[\s\S]*<\/blockquote>/);
    expect(html).toContain('下一项');
  });

  it('跨行行内公式保持数学下标，不产生引用链接或数学错误', () => {
    const text = '\\(x_{[0]}\n+y_{[99]}\\)，来源 [1]';
    const html = renderToStaticMarkup(createElement(MarkdownContent, { text, onCitation: () => {} }));
    expect(html.match(/class="katex"/g)).toHaveLength(1);
    expect(html.match(/citation-link/g)).toHaveLength(1);
    expect(html).not.toContain('katex-error');
  });

  it('多行引用块不把容器符号当公式，四空格代码保持字面内容', () => {
    const html = render('> \\[\n> x^2+y^2\n> \\]\n\n> \\(a\n> +b\\)\n\n    \\(x_1\\)');
    expect(html).toContain('encoding="application/x-tex">x^2+y^2</annotation>');
    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).not.toContain('&gt;');
    expect(html).toContain('<pre><code>\\(x_1\\)');
    expect(html).not.toContain('katex-error');
  });
});
