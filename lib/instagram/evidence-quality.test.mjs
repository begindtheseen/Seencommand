import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curateEvidence, normalizedEvidenceText, ocrQuality } from './evidence-quality.mjs';

const row = (id, type, content, timestamp = 0, video = 'v1') => ({
  evidence_id: id, video_id: video, evidence_type: type, content,
  timestamp_start: timestamp, timestamp_end: timestamp, confidence: 0.9,
});

test('normalizes whitespace without changing the stored row', () => {
  assert.equal(normalizedEvidenceText('  Build\n\n useful   products  '), 'Build useful products');
});

test('OCR quality rejects symbol soup and tiny fragments but retains readable screen text', () => {
  assert.equal(ocrQuality(row('bad', 'ocr', 'i\n\\\n|\n~\nYy\nff\n4\nSS')), 0);
  assert.equal(ocrQuality(row('tiny', 'ocr', 'of that')), 0);
  assert.ok(ocrQuality(row('good', 'ocr', 'Stop making your Claude Code projects look like AI slop')) >= 0.52);
  assert.equal(ocrQuality({ ...row('legacy', 'ocr', 'Readable words but no measured engine confidence'), confidence: 0.5 }), 0);
});

test('curation keeps speech/caption, removes broken OCR, deduplicates screens, and caps per video', () => {
  const rows = [
    row('spoken', 'spoken', 'Here is the strategy.', 1),
    row('caption', 'caption', 'Full post caption', 0),
    row('noise', 'ocr', 'i\n\\\n|\n~\nYy\nff\n4\nSS', 2),
    row('screen-a', 'ocr', 'Congratulations, you got the job. You can start Monday.', 3),
    row('screen-b', 'ocr', 'Congratulations you got the job! You can start Monday.', 4),
    row('screen-c', 'ocr', 'Use a transformation hook before explaining the numbered workflow.', 5),
  ];
  const curated = curateEvidence(rows, { maxOcrPerVideo: 2 });
  assert.deepEqual(curated.map((item) => item.evidence_id), ['caption', 'spoken', 'screen-b', 'screen-c']);
  assert.equal(rows.length, 6, 'raw evidence remains untouched');
});

test('deduplication is scoped to each video', () => {
  const text = 'Use a transformation hook before explaining the complete workflow.';
  const curated = curateEvidence([row('a', 'ocr', text, 1, 'v1'), row('b', 'ocr', text, 1, 'v2')]);
  assert.equal(curated.length, 2);
});
