// semantic-gate — the check that asks "did this change actually DO the work?"
//
// The deterministic gate proves a change BREAKS nothing. It never proves the change DOES anything, so
// an empty file passes it cleanly. That gap is the single deepest cause in NEXT_UPDATE.md: ten of the
// fifty recorded failures ended as "the reviewer rejected the change twice — needs a human", and the
// reviewer's own words name the same shapes every time:
//   task-147  "scripts/content-parser.mjs: The new file is empty"
//   run-…a3   "The diff is a placeholder/stub and does not contain any actual test code"
//   task-96   "the edits changed only comments — nothing effective to ship"
// Each of those cost two full reviewer rounds on a probabilistic model to discover something a
// deterministic reader can see for free. This runs BEFORE the reviewer and hard-fails those shapes.
//
// DESIGN CONSTRAINT, load-bearing: this gate FAILS BUILDS, so a false positive is far more expensive
// than a miss. A miss costs what we already pay today (the reviewer catches it). A false positive
// rejects working code and teaches the coder to distrust the gate.
//
// MEASURED, and it changed what shipped: a fourth rule — "calls a symbol defined nowhere", the
// task-78 shape — passed its unit tests on toy inputs and then produced **1,216 false positives
// across 139 real source files** in this repo. Destructured locals, arrow params, object shorthand
// and method calls all read as undefined project symbols to a regex. It is NOT here, deliberately.
// Catching it needs real scope analysis (a parser), not pattern matching, and until then the
// reviewer catches that shape one round later at a cost we can afford. The three rules that remain
// were run against the same 157-file corpus and produced ZERO findings.
//
// Pure and injectable: the caller supplies the touched paths and a reader for their content.

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#)/;
const BLANK = /^\s*$/;

// Strip comments and blank lines — what remains is the code a change actually contributes.
export function codeLines(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue; }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; continue; }
    if (BLANK.test(line) || COMMENT_LINE.test(line)) continue;
    out.push(line);
  }
  return out;
}

/**
 * semanticGateFindings — deterministic "did this do the work?" findings for a change.
 *
 * @param {object}   a
 * @param {string[]} a.touched      repo-relative paths the change created or modified
 * @param {(p:string)=>string} a.readFile   returns the file's CURRENT content (post-change)
 * @param {(p:string)=>boolean} [a.isNew]   true when the path did not exist before this change
 * @returns {{file:string, rule:string, reason:string}[]} empty = pass
 */
export function semanticGateFindings({ touched = [], readFile, isNew = () => false } = {}) {
  const findings = [];
  const read = (p) => { try { return String(readFile(p) ?? ''); } catch { return null; } };
  let anyCode = false;
  const codeFiles = [];

  for (const file of touched) {
    if (!/\.(mjs|js|jsx|ts|tsx)$/.test(file)) continue;
    const text = read(file);
    if (text === null) continue; // unreadable is UNKNOWN, never a violation
    const code = codeLines(text);
    codeFiles.push({ file, text, code });
    if (code.length) anyCode = true;

    // 1) A new file that contributes no code at all. The exact task-147 shape.
    if (isNew(file) && code.length === 0) {
      findings.push({
        file, rule: 'empty-new-file',
        reason: `${file} is a NEW file containing no code — only blank lines and comments. A file that declares nothing cannot satisfy the task; write the actual implementation.`,
      });
      continue;
    }

    // 2) A new test file with tests but no assertions — green by construction, proves nothing.
    if (/\.test\.(mjs|js|ts)$/.test(file) && code.length) {
      const hasTests = /\b(?:test|it|describe)\s*\(/.test(text);
      const hasAssert = /\bassert\b|\bexpect\s*\(|\.should\b/.test(text);
      if (hasTests && !hasAssert) {
        findings.push({
          file, rule: 'test-without-assertions',
          reason: `${file} defines test cases but contains no assertions, so it passes no matter what the code does. Every test must assert on real behaviour.`,
        });
      }
    }
  }

  // 3) The whole change contributes no code anywhere — the task-96 "only comments" shape. Skipped
  // when a per-file rule already fired: one empty new file is ONE problem, and reporting it twice
  // makes the retry brief look like the coder failed in two different ways.
  if (codeFiles.length && !anyCode && !findings.length) {
    findings.push({
      file: codeFiles.map((c) => c.file).join(', '), rule: 'comments-only',
      reason: 'the change edits only comments and whitespace — there is nothing effective to ship. If the task wants a document or a plan rather than code, it belongs to the deliverer, not the builder.',
    });
  }

  return findings;
}

// One block the coder's retry brief can consume verbatim — it must teach, not just reject.
export function semanticGateMessage(findings) {
  if (!findings || !findings.length) return null;
  return [
    `the change does not do the work (${findings.length} problem${findings.length === 1 ? '' : 's'} found before review):`,
    ...findings.map((f, i) => `${i + 1}. [${f.rule}] ${f.reason}`),
  ].join('\n');
}
