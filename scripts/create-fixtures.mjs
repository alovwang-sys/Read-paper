import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const samples = join(root, 'public/samples');
const fixtures = join(root, 'tests/fixtures');
const notice = 'Synthetic research fixture, not a real publication.';
const fixedDate = new Date('2026-01-01T00:00:00.000Z');
const ink = rgb(0.14, 0.19, 0.25);
const muted = rgb(0.35, 0.4, 0.45);
const teal = rgb(0.08, 0.42, 0.4);

async function document(title) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor('Read-paper fixture authors');
  pdf.setSubject(notice);
  pdf.setCreator('Read-paper deterministic fixture generator');
  pdf.setProducer('Read-paper / pdf-lib');
  pdf.setCreationDate(fixedDate);
  pdf.setModificationDate(fixedDate);
  return pdf;
}

function wrap(text, font, size, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function paragraph(page, text, font, y, { x = 54, width = 504, size = 11.5, leading = 17 } = {}) {
  for (const line of wrap(text, font, size, width)) {
    assert(y > 58, 'Fixture text must fit above the page footer.');
    page.drawText(line, { x, y, size, font, color: ink });
    y -= leading;
  }
  return y - 12;
}

function pageFrame(page, title, pageNumber, font, bold) {
  page.drawText('READ-PAPER / RESEARCH MATERIAL', { x: 54, y: 752, size: 8, font: bold, color: teal });
  page.drawLine({ start: { x: 54, y: 738 }, end: { x: 558, y: 738 }, thickness: 0.8, color: teal });
  page.drawText(title, { x: 54, y: 714, size: 11, font: bold, color: ink });
  page.drawText(notice, { x: 54, y: 695, size: 9, font, color: muted });
  page.drawLine({ start: { x: 54, y: 48 }, end: { x: 558, y: 48 }, thickness: 0.5, color: rgb(0.8, 0.83, 0.84) });
  page.drawText(`Fixture only | PDF page ${pageNumber}`, { x: 54, y: 32, size: 8, font, color: muted });
}

function heading(page, text, font, y, x = 54) {
  page.drawText(text, { x, y, size: 13, font, color: teal });
  return y - 24;
}

async function adaptiveRetrieval() {
  const title = 'Adaptive Retrieval for Evidence-Grounded Answers';
  const pdf = await document(title);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const sections = [
    [
      ['Abstract', [
        'This self-authored fixture describes an imaginary comparison between a fixed retrieval baseline and an adaptive evidence selection method. Its purpose is to exercise reading, text selection, citation navigation, and research notes in the Read-paper workbench.',
        'All methods, data, and results are synthetic. They must not be used as claims about a real system or publication. The document includes ordinary selectable text and stable page boundaries for reproducible product tests.',
      ]],
      ['1. Research question', [
        'When does adding a retrieval stage improve the factual quality of an answer? We compare answers grounded in a relevant evidence collection with answers grounded in a collection containing unrelated material.',
        'A useful comparison records the question, the available sources, the selected evidence, and the resulting answer. The answer can then be checked against the same source excerpts that were available at generation time.',
      ]],
      ['2. Evidence collection', [
        'The imaginary corpus contains short notes about a single research question. Each note has an identifier, a page number, and an excerpt. We retain these fields together because a quote without its source cannot support a reviewable conclusion.',
      ]],
    ],
    [
      ['3. Synthetic procedure', [
        'The fixed baseline always selects two notes. The adaptive method first checks whether a candidate note is relevant to the question, then chooses up to two relevant notes. Both methods receive the same synthetic corpus and the same answer length limit.',
        'A reviewer marks each statement as supported, contradicted, or absent from the selected notes. Supported statements are counted only when the source excerpt can be recovered by its document identifier and PDF page index.',
      ]],
      ['4. Imaginary results', [
        'In the relevant-corpus condition, the adaptive method produces more supported statements. In the unrelated-corpus condition, selecting additional notes does not create useful evidence. These are invented observations for software verification.',
        'Relevance is a condition of the example, not a universal property of retrieval. The test deliberately preserves this qualification so that cards and conclusions can represent both the claim and its limits.',
      ]],
      ['5. Reproducibility notes', [
        'A reliable answer should preserve a traceable link to its supporting evidence.',
        'The fixture generator fixes metadata dates, typography, page size, and content. Re-running the generator should create the same bytes. The paper uses a single text column and three PDF pages.',
        'Text extraction and rendering are separate capabilities. This fixture has a text layer, while the accompanying scanned research note contains a raster image and no selectable page text.',
      ]],
    ],
    [
      ['6. Main finding', [
        'Retrieval improves factual accuracy when the evidence corpus is relevant.',
        'This exact sentence is the selection target for the end-to-end research workflow. It is intentionally located on PDF page 3, whose internal page index is 2. It should remain selectable after zooming or reopening the document.',
      ]],
      ['7. Conditions and limits', [
        'The finding is conditional on source relevance and recoverable citations. A fluent answer may still contain unsupported details. Reviewers should inspect the original excerpt rather than treating the presence of a citation as proof of correctness.',
        'The fixture makes no claim about real benchmark performance. It exists to demonstrate evidence cards, shared card reuse, board organization, and a conclusion export that includes bibliography details, PDF page numbers, and quotations.',
      ]],
      ['8. Conclusion', [
        'A research note is easier to verify when its claims preserve the conditions under which they were observed. Explicit source excerpts let the reader revisit the same evidence while writing a conclusion.',
        'Suggested synthetic citation: Read-paper fixture authors (2026). Adaptive Retrieval for Evidence-Grounded Answers. Self-authored software test material; not a real publication.',
      ]],
    ],
  ];
  sections.forEach((items, index) => {
    const page = pdf.addPage([612, 792]);
    pageFrame(page, title, index + 1, font, bold);
    let y = 654;
    for (const [name, paragraphs] of items) {
      y = heading(page, name, bold, y);
      for (const text of paragraphs) y = paragraph(page, text, font, y);
      y -= 8;
    }
  });
  assert.equal(pdf.getPageCount(), 3);
  return { pdf, title, pageCount: 3, quote: sections[2][0][1][0], quotePageIndex: 2, layout: 'single-column', textLayer: true };
}

async function retrievalBaseline() {
  const title = 'A Fixed Retrieval Baseline and Its Limits';
  const pdf = await document(title);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = [
    [
      ['1. Baseline design', [
        'The fixed baseline selects the same number of notes for every question. This synthetic two-column document represents a contrasting source for the workbench research example.',
        'A fixed retrieval budget does not guarantee relevant evidence.',
        'Irrelevant retrieved passages can increase uncertainty rather than reduce it.',
        'The budget determines how many notes are selected. It does not determine whether those notes address the question or whether the answer accurately represents their contents.',
        'For a fair imaginary comparison, the fixed and adaptive methods share the same question, source collection, and answer length limit. Only the evidence selection rule differs.',
      ]],
      ['2. Evaluation notes', [
        'A reviewer follows each answer statement back to a selected source. Source identifiers and PDF page indexes are retained with the excerpt, allowing later research notes to show exactly what was checked.',
        'Unsupported detail must remain distinguishable from supported detail. A plausible sentence without matching evidence cannot become a reliable conclusion merely by being repeated.',
        'The column layout is intentional. It verifies that reading and selecting text works for ordinary multi-column PDF material in addition to the single-column companion fixture.',
      ]],
    ],
    [
      ['3. Failure condition', [
        'Irrelevant sources can leave retrieval-based answers unsupported.',
        'The imaginary failure condition places unrelated notes in the corpus. The baseline still retrieves the fixed number of notes, but those notes cannot establish the requested claim.',
        'Increasing the evidence count alone does not resolve this failure. The research question and the source excerpt must concern the same claim before the excerpt can support a useful answer.',
        'These statements are authored examples, not measurements. They support a controlled software test of comparing two pieces of evidence and preserving qualifications in a conclusion.',
      ]],
      ['4. Research use', [
        'Use this source as a limitation card alongside the adaptive retrieval card. The board can connect the two card placements with a relation such as condition or limitation.',
        'A complete export should identify this fixture, its authors and year, the PDF page containing the excerpt, and the exact quote. It should not claim to include the original PDF unless the export actually contains it.',
        'Suggested synthetic citation: Read-paper fixture authors (2026). A Fixed Retrieval Baseline and Its Limits. Self-authored software test material; not a real publication.',
      ]],
    ],
  ];
  pages.forEach((columns, index) => {
    const page = pdf.addPage([612, 792]);
    pageFrame(page, title, index + 1, font, bold);
    page.drawLine({ start: { x: 306, y: 666 }, end: { x: 306, y: 110 }, thickness: 0.4, color: rgb(0.88, 0.9, 0.91) });
    columns.forEach(([name, paragraphs], column) => {
      const x = column ? 321 : 54;
      let y = heading(page, name, bold, 654, x);
      for (const text of paragraphs) y = paragraph(page, text, font, y, { x, width: 237, size: 11, leading: 16 });
    });
  });
  assert.equal(pdf.getPageCount(), 2);
  return { pdf, title, pageCount: 2, quote: pages[0][0][1][1], quotePageIndex: 0, layout: 'two-column', textLayer: true };
}

// A tiny bitmap alphabet keeps the scan reproducible without another image dependency.
const alphabet = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
  C: '01111100001000010000100001000001111', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01111100001000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '11111001000010000100001000010011111', J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001110011010110011100011000110001',
  O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011101110001', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  '1': '00100011000010000100001000010001110', '2': '01110100010000100110010001000011111',
  '3': '11110000010000101110000010000111110', '.': '00000000000000000000000000011000110',
};

function rasterScan() {
  const width = 1224;
  const height = 1584;
  const pixels = Buffer.alloc(width * height * 3, 255);
  function rect(x, y, w, h, color) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        const offset = (row * width + col) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
    }
  }
  function text(line, x, y, scale = 4, color = [35, 49, 64]) {
    for (const char of line) {
      if (char !== ' ') {
        const glyph = alphabet[char];
        assert(glyph, `Missing raster glyph: ${char}`);
        for (let i = 0; i < 35; i++) {
          if (glyph[i] === '1') rect(x + (i % 5) * scale, y + Math.floor(i / 5) * scale, scale, scale, color);
        }
      }
      x += 6 * scale;
    }
    assert(x < width - 80, 'Raster text must fit on the page.');
  }
  rect(82, 92, 1060, 7, [20, 108, 102]);
  text('SCANNED RESEARCH NOTE', 90, 152, 6);
  text('SYNTHETIC RESEARCH FIXTURE', 90, 244);
  text('NOT A REAL PUBLICATION.', 90, 290);
  rect(90, 380, 1040, 2, [204, 215, 218]);
  text('1. EVIDENCE MUST BE RELEVANT.', 90, 452);
  text('A NOTE CAN SUPPORT A CLAIM ONLY', 90, 520);
  text('WHEN IT ADDRESSES THE QUESTION.', 90, 566);
  text('2. SOURCES MUST BE RECOVERABLE.', 90, 708);
  text('KEEP THE SOURCE AND PAGE NUMBER', 90, 776);
  text('WITH EACH ORIGINAL EXCERPT.', 90, 822);
  text('3. THIS PAGE IS AN IMAGE.', 90, 964);
  text('THE PDF HAS NO TEXT LAYER.', 90, 1032);
  text('OCR IS OUTSIDE THE FIRST RELEASE.', 90, 1078);
  rect(90, 1384, 1040, 2, [204, 215, 218]);
  text('FIXTURE ONLY. PDF PAGE 1.', 90, 1436, 3);

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

async function scannedNote() {
  const title = 'Scanned Research Note: Evidence and Source Recovery';
  const pdf = await document(title);
  const page = pdf.addPage([612, 792]);
  const image = await pdf.embedPng(rasterScan());
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  assert.equal(pdf.getPageCount(), 1);
  const fonts = page.node.Resources().get(PDFName.of('Font'));
  assert(!fonts || fonts.keys().length === 0, 'The scan must have no text font resource.');
  return { pdf, title, pageCount: 1, quote: null, quotePageIndex: null, layout: 'raster-only', textLayer: false };
}

await mkdir(samples, { recursive: true });
await mkdir(fixtures, { recursive: true });
const manifest = [];
for (const [filename, create] of [
  ['adaptive-retrieval.pdf', adaptiveRetrieval],
  ['retrieval-baseline.pdf', retrievalBaseline],
  ['scanned-note.pdf', scannedNote],
]) {
  const { pdf, ...entry } = await create();
  const bytes = await pdf.save({ useObjectStreams: false });
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), entry.pageCount);
  await writeFile(join(samples, filename), bytes);
  manifest.push({ filename, ...entry });
  console.log(`${filename}: ${entry.pageCount} pages; ${entry.layout}; text layer ${entry.textLayer}`);
}
const malformed = Buffer.from('%PDX-1.7\nIntentionally corrupt PDF fixture: damaged header and missing document objects.\n%%EOF\n');
await assert.rejects(PDFDocument.load(malformed));
await writeFile(join(fixtures, 'malformed.pdf'), malformed);
await writeFile(join(fixtures, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log('malformed.pdf: intentionally invalid; tests/fixtures/manifest.json records valid samples');
