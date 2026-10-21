import { createHash } from 'node:crypto';
import type { DrawingQuestion } from '../../src/domain/types';
import { drawingSnapshotContent } from '../../src/domain/drawing-question';

export const drawingPng = new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' });
export const drawingDigest = (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
export async function drawingQuestionFixture(): Promise<DrawingQuestion> {
  const hash = drawingDigest(await drawingPng.arrayBuffer());
  const question: DrawingQuestion = { mode: 'image', snapshot: {
    id: 'question-fixture', boardId: 'board-a', boardTitle: '所选画面', createdAt: '2026-10-21T00:00:00Z', hash: '0'.repeat(64),
    image: { assetId: `drawing-question-${hash}`, hash, width: 1, height: 1 },
    elements: [{ id: 'label', type: 'text', x: 10, y: 10, width: 80, height: 30, angle: 0, text: '选择范围内的问题' }], connections: [],
  } };
  question.snapshot.hash = drawingDigest(new TextEncoder().encode(drawingSnapshotContent(question.snapshot)).buffer);
  return question;
}
