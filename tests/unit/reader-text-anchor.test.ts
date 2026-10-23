import { describe, expect, it } from 'vitest';
import { normalizedPageText, quotePosition } from '../../src/features/reader/text-anchor';

describe('PDF text anchor positions', () => {
  it('uses one canonical whitespace map for the rendered PDF spans', () => {
    expect(normalizedPageText(['  repeated\n sentence ', '', ' repeated   sentence  '])).toBe('repeated sentence repeated sentence');
  });
  it('keeps the second identical sentence at its selected position', () => {
    const text = 'same sentence other words same sentence';
    expect(quotePosition(text, 'same sentence', { start: 26, end: 39, prefix: 'other words ', suffix: '' })).toEqual({ start: 26, end: 39, prefix: 'other words ', suffix: '' });
  });
  it('does not silently move a stale anchored quote to another occurrence', () => {
    expect(quotePosition('same sentence other words same sentence', 'same sentence', { start: 0, end: 13, prefix: 'missing' })).toBeUndefined();
    expect(quotePosition('same sentence', 'same sentence')).toEqual({ start: 0, end: 13 });
  });
});
