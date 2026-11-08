// Evidence quality policy shared by the Claude compiler and the Creator Library.
//
// Raw evidence remains untouched in state.sqlite and the project Files view. This module creates a
// conservative working/view layer: speech and captions are retained, while obviously broken OCR is
// rejected, repeated screenshots are deduplicated, and OCR is bounded per video. Knowledge citations
// still use the original evidence IDs, timestamps, excerpts, and confidence values.

const WORD = /[A-Za-z0-9@#][A-Za-z0-9@#.'’/-]*/g;
const VOWEL = /[aeiouy]/i;

export function normalizedEvidenceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensFor(value) {
  return (normalizedEvidenceText(value).toLowerCase().match(WORD) || [])
    .map((token) => token.replace(/^[-/.']+|[-/.']+$/g, ''))
    .filter(Boolean);
}

// A deliberately conservative OCR score. It is intended to reject visual garbage, not to assert
// that retained text is correct. Tesseract's real confidence is collected for future evidence; this
// score also protects older projects where every OCR row was stored as a guessed 0.5.
export function ocrQuality(row) {
  const engine = Number(row?.confidence);
  // Older compiler releases hardcoded every OCR row to 0.5. That value conveys no measured quality,
  // so those rows remain raw/auditable but cannot enter the trusted working set.
  if (!Number.isFinite(engine) || engine <= 0.5) return 0;
  const raw = String(row?.content || '');
  const text = normalizedEvidenceText(raw);
  const tokens = tokensFor(text);
  const chars = [...text];
  const alphaNumeric = chars.filter((c) => /[A-Za-z0-9]/.test(c)).length;
  const symbols = chars.filter((c) => !/[A-Za-z0-9\s.,!?@#%&'’():+/-]/.test(c)).length;
  const single = tokens.filter((t) => t.length === 1 && !/^[ai0-9]$/i.test(t)).length;
  const useful = tokens.filter((t) => /\d/.test(t) || (t.length >= 3 && VOWEL.test(t))).length;
  const veryLong = tokens.filter((t) => t.length > 24 && !/^https?:/i.test(t)).length;
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fragmentLines = lines.filter((line) => line.replace(/[^A-Za-z0-9]/g, '').length <= 2).length;

  if (text.length < 12 || text.length > 1200 || tokens.length < 3 || alphaNumeric < 10) return 0;
  if (veryLong > 0) return 0;
  if (alphaNumeric / Math.max(chars.length, 1) < 0.48) return 0;
  if (symbols / Math.max(chars.length, 1) > 0.16) return 0;
  if (single / Math.max(tokens.length, 1) > 0.3) return 0;
  if (useful / Math.max(tokens.length, 1) < 0.42) return 0;
  if (lines.length >= 5 && fragmentLines / lines.length > 0.42) return 0;

  const lexical = Math.min(1, useful / 10);
  const density = Math.min(1, alphaNumeric / Math.max(chars.length, 1) / 0.82);
  const length = Math.min(1, text.length / 90);
  const engineConfidence = Math.max(0, Math.min(1, engine));
  return Number((0.38 * lexical + 0.28 * density + 0.2 * length + 0.14 * engineConfidence).toFixed(4));
}

function tokenSet(row) {
  return new Set(tokensFor(row?.content).filter((token) => token.length >= 3));
}

function similarity(a, b) {
  const left = tokenSet(a); const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function timeOf(row) {
  const value = Number(row?.timestamp_start);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function curateVideo(rows, maxOcrPerVideo) {
  const stable = rows.filter((row) => {
    const type = String(row?.evidence_type || '').toLowerCase();
    return (type === 'spoken' || type === 'caption') && normalizedEvidenceText(row?.content);
  });
  const rankedOcr = rows
    .filter((row) => String(row?.evidence_type || '').toLowerCase() === 'ocr')
    .map((row) => ({ row, score: ocrQuality(row) }))
    .filter((item) => item.score >= 0.52)
    .sort((a, b) => b.score - a.score || timeOf(a.row) - timeOf(b.row) || String(a.row.evidence_id || '').localeCompare(String(b.row.evidence_id || '')));

  const keptOcr = [];
  if (maxOcrPerVideo <= 0) return stable.sort((a, b) => timeOf(a) - timeOf(b));
  for (const item of rankedOcr) {
    if (keptOcr.some((kept) => similarity(item.row, kept) >= 0.72)) continue;
    keptOcr.push(item.row);
    if (keptOcr.length >= maxOcrPerVideo) break;
  }
  return [...stable, ...keptOcr].sort((a, b) => timeOf(a) - timeOf(b)
    || String(a?.evidence_type || '').localeCompare(String(b?.evidence_type || ''))
    || String(a?.evidence_id || '').localeCompare(String(b?.evidence_id || '')));
}

export function curateEvidence(rows, { maxOcrPerVideo = 12 } = {}) {
  const grouped = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.video_id || '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return [...grouped.keys()].sort().flatMap((key) => curateVideo(grouped.get(key), Math.max(0, Number(maxOcrPerVideo) || 0)));
}
