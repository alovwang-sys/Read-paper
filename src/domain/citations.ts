export function remapCitationNumbers(
  body: string,
  sourceIds: string[],
  targetIds: string[],
): string {
  return body.replace(/\[(-?\d+)\]/g, (_marker, number: string) => {
    const sourceId = sourceIds[Number(number) - 1];
    const targetIndex = targetIds.indexOf(sourceId);
    if (!sourceId || targetIndex < 0)
      throw new Error(
        `正文引用 [${number}] 没有对应的原文证据，请修复引用编号。`,
      );
    return `[${targetIndex + 1}]`;
  });
}
