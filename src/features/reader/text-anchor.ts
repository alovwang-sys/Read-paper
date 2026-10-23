export type TextAnchor = { start: number; end: number; prefix?: string; suffix?: string };
type Character = { value: string; node: Text; start: number; end: number };

export const normalizedPageText = (spans: string[]) => spans.map(text => text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');

function pageCharacters(layer: HTMLElement): Character[] {
  const result: Character[] = [];
  const spans = [...layer.querySelectorAll('span')].filter(span => !span.querySelector('span') && span.textContent?.trim());
  for (const span of spans) {
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT), characters: Character[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text;
      for (let offset = 0; offset < text.length; offset++) {
        const value = /\s/.test(text.data[offset]) ? ' ' : text.data[offset];
        if (value === ' ' && (!characters.length || characters.at(-1)?.value === ' ')) continue;
        characters.push({ value, node: text, start: offset, end: offset + 1 });
      }
    }
    if (characters.at(-1)?.value === ' ') characters.pop();
    if (!characters.length) continue;
    if (result.length) result.push({ ...characters[0], value: ' ', end: characters[0].start });
    result.push(...characters);
  }
  return result;
}

/** Selection and restored marks use the same PDF text-layer character map. */
export function captureTextAnchor(layer: HTMLElement, selection: Range): TextAnchor | undefined {
  const characters = pageCharacters(layer);
  let start = -1, end = -1;
  characters.forEach((character, index) => {
    if (character.value !== ' ' && selection.comparePoint(character.node, character.start) === 0
      && selection.comparePoint(character.node, character.end) === 0) {
      if (start < 0) start = index;
      end = index + 1;
    }
  });
  if (start < 0) return;
  const text = characters.map(character => character.value).join('');
  return { start, end, prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48) };
}

export function quotePosition(text: string, quote: string, anchor?: TextAnchor): { start: number; end: number } | undefined {
  if (anchor) {
    if (anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= text.length
      && (!anchor.prefix || text.slice(Math.max(0, anchor.start - anchor.prefix.length), anchor.start) === anchor.prefix)
      && (!anchor.suffix || text.slice(anchor.end, anchor.end + anchor.suffix.length) === anchor.suffix)) return anchor;
    // Do not move an anchored mark to the first occurrence of a repeated sentence.
    return;
  }
  const selected = quote.replace(/\s+/g, ' ').trim(), start = selected ? text.indexOf(selected) : -1;
  return start < 0 ? undefined : { start, end: start + selected.length };
}

export function rangeForTextAnchor(layer: HTMLElement, quote: string, anchor?: TextAnchor): Range | undefined {
  const characters = pageCharacters(layer), text = characters.map(character => character.value).join('');
  const position = quotePosition(text, quote, anchor);
  const first = position && characters[position.start], last = position && characters[position.end - 1];
  if (!first || !last) return;
  const range = document.createRange();
  range.setStart(first.node, first.start); range.setEnd(last.node, last.end);
  return range;
}

export function textInsideRegion(layer: HTMLElement, rect: { x: number; y: number; width: number; height: number }): string {
  const bounds = layer.getBoundingClientRect(), range = document.createRange();
  return pageCharacters(layer).filter(character => {
    range.setStart(character.node, character.start); range.setEnd(character.node, character.end);
    const box = range.getBoundingClientRect(), x = (box.left + box.width / 2 - bounds.left) / bounds.width;
    const y = (box.top + box.height / 2 - bounds.top) / bounds.height;
    return box.width > 0 && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
  }).map(character => character.value).join('').replace(/\s+/g, ' ').trim();
}
