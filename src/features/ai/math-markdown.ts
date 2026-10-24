/** Preserve Markdown literals while accepting the TeX delimiters used by assistants. */
export function normalizeMathDelimiters(text: string): string {
  // shortcut: four-space lines stay literal; use dollar math in deeply indented lists until container-aware parsing is needed.
  return text.replace(
    /(?<literal>(?<fence>`{3,}|~{3,})[\s\S]*?(?:\k<fence>|(?![\s\S]))|(?<ticks>`+)[\s\S]*?(?<!`)\k<ticks>(?!`)|^(?: {4}|\t)[^\n]*|!?\[[^\]\n]*\]\((?:[^()\n\\]|\\.|\([^()\n]*\))*\)|^[ \t]*\[[^\]\n]+\]:[^\n]*|<[^>\n]*>|\\\\|(?<!\\)\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]+\$)|\\\((?<inline>[\s\S]*?)\\\)|\\\[(?<display>[\s\S]*?)\\\]/gm,
    (...args) => {
      const groups = args.at(-1) as { literal?: string; inline?: string; display?: string };
      if (groups.literal !== undefined) return args[0];
      const offset = args.at(-3) as number;
      const prefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
      // Keep block formulas inside their original list or blockquote container.
      const container = prefix.match(/^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?/)?.[0] ?? '';
      const indent = container.replace(/(?:[-+*]|\d+[.)])([ \t]+)$/, token => ' '.repeat(token.length));
      const quote = container.match(/^(?:[ \t]*>[ \t]?)+/)?.[0];
      const body = (groups.inline ?? groups.display!).split('\n').map((line, index) => index && quote && line.startsWith(quote) ? line.slice(quote.length) : line).join('\n').trim();
      if (groups.inline !== undefined) return `$${body}$`;
      return `\n${indent}$$\n${indent}${body.replace(/\n/g, `\n${indent}`)}\n${indent}$$\n${indent}`;
    },
  );
}
