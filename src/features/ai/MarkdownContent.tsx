import { mapCitationNumbers } from '../../domain/citations';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathDelimiters } from './math-markdown';

/** Model output remains text; raw HTML is never executed. */
export function MarkdownContent({ text, onCitation }: { text: string; onCitation?: (number: number) => void }) {
  const markdown = normalizeMathDelimiters(onCitation ? mapCitationNumbers(text, number => `[${number}](#papertrail-citation-${number})`) : text);
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        skipHtml
        components={{
          a: ({ children, href }) => onCitation && /^#papertrail-citation--?\d+$/.test(href ?? '') ? <button className="text-button citation-link" onClick={() => onCitation(Number(href!.replace('#papertrail-citation-', '')))}>[{children}]</button> : (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="ai-image-placeholder">
              [图片：{alt || '模型提供的图片'}]
            </span>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
