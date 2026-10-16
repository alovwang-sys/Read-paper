# Self-authored PDF samples

These files are synthetic research fixtures created for this project. They are not real publications and contain no third-party paper content. Their author is `Read-paper fixture authors`, and their fixture year is 2026. All results and observations are invented software test material.

Regenerate them with `node scripts/create-fixtures.mjs` after installing the project's dependencies. The script uses `pdf-lib` and Node's standard library. Metadata dates, page size, typography, and text are fixed for repeatable generation. It also writes the intentionally corrupt `tests/fixtures/malformed.pdf` and the sample manifest.

| Sample | Pages | Content | Selection target |
| --- | --- | --- | --- |
| `adaptive-retrieval.pdf` | 3 | Single column with a text layer | PDF page 3: `Retrieval improves factual accuracy when the evidence corpus is relevant.` |
| `retrieval-baseline.pdf` | 2 | Two columns with a text layer | PDF page 1: `A fixed retrieval budget does not guarantee relevant evidence.` |
| `scanned-note.pdf` | 1 | Embedded raster image without a text layer | No selectable text; used to check the OCR capability boundary |

Page indexes in the application's evidence data are zero-based. Thus PDF page 3 uses `pageIndex: 2`. Printed page labels are only fixture labels and should not be used as the source of the PDF page index.

Additional seed excerpts are on fixed pages: `A reliable answer should preserve a traceable link to its supporting evidence.` is on PDF page 2 (`pageIndex: 1`) of the single-column sample; `Irrelevant retrieved passages can increase uncertainty rather than reduce it.` is on PDF page 1 (`pageIndex: 0`) of the two-column sample.
