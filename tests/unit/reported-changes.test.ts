import { describe, expect, it } from 'vitest';
import { summarizeReportedChanges } from '../../src/features/ai/ReportedChanges';

describe('原生已报告变更摘要', () => {
  it('只统计hunk里的增删行，文件头去重，重命名和二进制文件不虚构行数', () => {
    const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n+second\ndiff --git a/p.png b/p.png\nBinary files differ\ndiff --git a/a.ts b/a.ts\n';
    expect(summarizeReportedChanges(diff)).toEqual({ files: 2, additions: 2, deletions: 1 });
  });
  it('空数据及没有hunk的元数据不产生虚构的增删行', () => {
    expect(summarizeReportedChanges('')).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(summarizeReportedChanges('diff --git a/old b/new\nrename from old\nrename to new\n')).toEqual({ files: 1, additions: 0, deletions: 0 });
  });
});
