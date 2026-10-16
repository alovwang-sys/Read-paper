import { FileDiff } from 'lucide-react';

export function summarizeReportedChanges(diff: string) {
  const files = new Set<string>();
  let additions = 0, deletions = 0, hunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { files.add(line); hunk = false; }
    else if (line.startsWith('@@ ')) hunk = true;
    else if (hunk && line.startsWith('+')) additions++;
    else if (hunk && line.startsWith('-')) deletions++;
  }
  return { files: files.size, additions, deletions };
}

export function ReportedChanges({ diff }: { diff?: string }) {
  if (!diff?.trim()) return null;
  const summary = summarizeReportedChanges(diff);
  return <details className="ai-reported-changes">
    <summary><FileDiff size={14} /><span>{summary.files ? `${summary.files} 个文件已更改` : '查看文件变更'}</span>{!!summary.files && <><ins>+{summary.additions}</ins><del>−{summary.deletions}</del></>}</summary>
    <p>本轮 Codex 已报告的变更节选，未扫描整个项目工作树。</p>
    <pre aria-label="本轮文件变更">{diff}</pre>
  </details>;
}
