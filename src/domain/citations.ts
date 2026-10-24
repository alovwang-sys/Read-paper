export function mapCitationNumbers(body: string, transform: (number: number) => string): string {
  return body.replace(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+|\\\\|\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\[-?\d+\]\([^\n]*?\)|\[-?\d+\]\[[^\]\n]*\])|\[(-?\d+)\](?!:)/g, (match, literal: string | undefined, number: string) => literal ?? transform(Number(number)));
}

export function remapCitationNumbers(
  body: string,
  sourceIds: string[],
  targetIds: string[],
): string {
  return mapCitationNumbers(body, (number) => {
    const sourceId = sourceIds[number - 1];
    const targetIndex = targetIds.indexOf(sourceId);
    if (!sourceId || targetIndex < 0)
      throw new Error(
        `正文引用 [${number}] 没有对应的原文证据，请修复引用编号。`,
      );
    return `[${targetIndex + 1}]`;
  });
}
