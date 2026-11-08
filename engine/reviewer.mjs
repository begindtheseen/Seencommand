// DIFF REVIEWER — the judgment half of the competence fix. The 14B coder writes plausible-SHAPED
// code; the gate proves it breaks nothing; nothing ever asked "does this diff actually do the task,
// and is everything it references real?" That's how gate-green PRs shipped dead chips reading
// nonexistent signals (#73), deleted load-bearing proposal copy for a kind no worker has (#74), and
// hardcoded version fiction (#67). Before the builder commits, a STRONGER model (hosted lanes, the
// same escalation chain the coder uses) reviews the diff against the task with repo grounding, and
// a rejection feeds back into the coder's retry loop with the named defects. Two rejections = the
// build aborts honestly. It FAILS CLOSED: no verdict, no ship. CODER_REVIEW=0 turns the reviewer off —
// and with it the builder's ability to push anything (dry runs only).

import { execFileSync } from 'node:child_process';
import { reason, extractJson } from '../lib/llm.mjs';
import { logActivity } from '../lib/activity.mjs';

const SYSTEM = 'You are a ruthless senior code reviewer. You reject changes that reference things that do not exist, '
  + 'do not accomplish the stated task, or damage neighboring code. You answer ONLY with JSON.';

// Repo grounding for the reviewer: for each identifier-ish token the diff ADDS, show where (or
// whether) it appears elsewhere in the repo — existence evidence the reviewer can trust over vibes.
export function groundingFor(repoRoot, diff, { maxTokens = 12 } = {}) {
  const names = new Set();
  for (const line of String(diff).split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    for (const m of line.matchAll(/\.([a-zA-Z_$][\w$]{2,})\b|\b([a-zA-Z_$][\w$]{3,})\s*\(/g)) {
      names.add(m[1] || m[2]);
      if (names.size >= maxTokens) break;
    }
    if (names.size >= maxTokens) break;
  }
  const lines = [];
  for (const n of names) {
    let hits = '';
    try { hits = execFileSync('git', ['grep', '-c', '-w', n], { cwd: repoRoot, encoding: 'utf8' }); } catch { hits = ''; }
    const count = hits.split('\n').filter(Boolean).reduce((a, l) => a + Number(l.split(':').pop() || 0), 0);
    lines.push(`- "${n}": ${count} occurrence(s) in the repo${count <= 1 ? ' ← appears ONLY in this diff — verify it exists' : ''}`);
  }
  return lines.join('\n');
}

// Build the reviewable diff for `touched`, INCLUDING new files. `git diff` prints NOTHING for an
// untracked path, so a build whose only output is new files would otherwise reach reviewDiff as an
// empty diff and ship with zero semantic review (Seen #194: a new-file-only stub page — first line a
// literal markdown fence, non-compiling, task-unrelated — sailed through logged as "no-diff accepted").
// For each touched path git does not track, synthesize its diff against /dev/null so every line of the
// new file becomes visible +content that groundingFor and the reviewer prompt can see. Tracked changes
// first, then untracked paths in touched order.
export function diffForReview(repoRoot, touched = []) {
  const git = (args) => {
    // `git diff --no-index` exits 1 when the files differ — the normal case for a new file vs
    // /dev/null — but still writes the diff to stdout, which execFileSync attaches to the thrown
    // error object. Read it there, matching this file's existing execFileSync/try-catch patterns.
    try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { return typeof e.stdout === 'string' ? e.stdout : ''; }
  };
  const parts = [];
  const tracked = git(['diff', '--', ...touched]);
  if (tracked) parts.push(tracked);
  for (const path of touched) {
    let isTracked = true;
    try { execFileSync('git', ['ls-files', '--error-unmatch', '--', path], { cwd: repoRoot, stdio: 'pipe' }); }
    catch { isTracked = false; } // --error-unmatch fails (non-zero) when the path is untracked
    if (!isTracked) parts.push(git(['diff', '--no-index', '--', '/dev/null', path]));
  }
  return parts.join('');
}

// How much diff one reviewer round may carry. The old code sent `diff.slice(0, 9000)` and judged the
// WHOLE change on it — everything past the cut shipped unreviewed. A larger change is now reviewed in
// per-file parts (each part sees the full file manifest); a single file too large for one part cannot
// be reviewed at all, and an unreviewable change is a BLOCKED change.
export const REVIEW_PART_CHARS = 24000;

// Split a unified diff into per-file segments, then pack them into parts of at most `max` chars.
// Returns { parts: string[], oversized: string|null } — oversized names a file no part can hold.
export function reviewParts(diff, max = REVIEW_PART_CHARS) {
  const segments = String(diff).split(/^(?=diff --git )/m).filter((seg) => seg.trim());
  const parts = []; let cur = '';
  for (const seg of segments) {
    if (seg.length > max) return { parts: [], oversized: (/^diff --git a\/(\S+)/.exec(seg) || [])[1] || '(unknown file)' };
    if (cur && cur.length + seg.length > max) { parts.push(cur); cur = ''; }
    cur += seg;
  }
  if (cur) parts.push(cur);
  return { parts, oversized: null };
}

// Review the working-tree diff of `touched` against the task.
// Returns { ship, defects[], engine } — plus `blocked: '<why>'` when NO verdict could be rendered.
//
// FAIL CLOSED. This is the only layer that asks "does this diff actually do the task?", so it is a
// correctness gate, not commentary: `ship` is true ONLY on an explicit, parseable `"ship": true` with
// no defects, covering the ENTIRE diff. It used to fail open "for availability" — no lane, garbage
// after the retry ladder, review disabled, an empty diff, a reply with no `ship` key at all
// (`j.ship !== false`), and everything past char 9000 all shipped. Those are exactly the states in
// which nothing has vouched for the change (Seen #195, seen-command #106: "gemini:unparseable —
// accepted"). A blocked review is NOT a rejection: the coder did nothing wrong and must not burn a
// retry on it — the builder stops with an owner-action reason (a reviewer lane has to come back).
// The RETRY LADDER still runs first: (a) one stricter reprompt to the SAME lane, (b) one attempt on
// the OTHER side (hosted↔local). Every blocked exit lands one line in the activity ledger.
export async function reviewDiff({ task, repoRoot, touched, reasonFn = reason, log = () => {} } = {}) {
  const block = (why, engine) => {
    log(`[reviewer] ${why} — change BLOCKED (nothing vouched for it; it will not ship)`);
    logActivity({ kind: 'review', status: 'blocked', summary: `review blocked (${why}): ${String(task ?? '').slice(0, 140)}`, detail: why });
    return { ship: false, defects: [], engine, blocked: why };
  };
  if (process.env.CODER_REVIEW === '0') return block('semantic review is disabled (CODER_REVIEW=0)', 'disabled');
  const diff = diffForReview(repoRoot, touched); // tracked changes + synthesized diffs for new files
  if (!diff.trim()) return block('no reviewable diff for the touched files', 'no-diff');
  const { parts, oversized } = reviewParts(diff);
  if (oversized) return block(`the diff of ${oversized} is too large to review in one part — split the task`, 'too-large');
  const manifest = [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => `- ${m[1]}`).join('\n');

  const promptFor = (part, i) => {
    const grounding = groundingFor(repoRoot, part);
    const scope = parts.length > 1
      ? `THIS IS PART ${i + 1} OF ${parts.length} of one change. Every file the change touches:\n${manifest}\nJudge the defects visible in THIS part; judge rule (2) against the change as a whole.\n\n`
      : '';
    return `TASK the change claims to accomplish:\n${task}\n\n${scope}THE DIFF:\n${part}\n\n`
    + `EXISTENCE EVIDENCE (occurrences of referenced names across the whole repo):\n${grounding || '- (none extracted)'}\n\n`
    + 'Reject if ANY hold: (1) the diff references a function/key/signal/kind that the evidence shows exists only in this diff and the diff does not define it; '
    + '(2) the diff does not actually accomplish the task (placeholders, comments-as-work, unrelated edits); '
    + '(3) it deletes or damages neighboring code the task did not ask to change (dropped characters, removed entries); '
    + '(4) it moves a secret toward the client (a NEXT_PUBLIC_* name holding a service/secret key, a server key read in components/hooks, a hardcoded credential); '
    + '(5) it adds something nothing can reach (a new module no file imports, a UI branch with no entry point, data fetched into a variable nothing reads); '
    + '(6) a NEW file (included here as an all-addition diff against /dev/null) is a placeholder/stub, contains markdown code fences (```), or is otherwise not real, wired-in code.\n'
    + 'Answer ONLY: {"ship": true|false, "defects": ["specific defect — file and what to change", ...]} — defects empty when ship is true.';
  };
  // One reviewer round on a given `side` ({hostedOnly} | {localOnly}) with prompt `p`.
  const ask = (side, p) => reasonFn({ deptId: 'product', competence: 'reason', ...side, maxTokens: 500, system: SYSTEM, prompt: p, fallback: '', timeoutMs: 240000 }); // local reviewers read whole diffs — the 20s default silences them
  const dead = (res) => !res || res.engine === 'fallback' || !res.text; // no lane answered on this round
  // Parse a reply into a verdict, or null when it isn't the JSON contract — null is what drives the
  // ladder. `ship` must be an explicit boolean: an object with no `ship` key is NOT an approval. And an
  // approval that lists defects contradicts itself — the defects win.
  const verdict = (res) => {
    try {
      const j = extractJson(res.text);
      if (!j || typeof j.ship !== 'boolean') return null;
      const defects = (Array.isArray(j.defects) ? j.defects : []).map((d) => String(d).slice(0, 300)).slice(0, 6);
      return { ship: j.ship === true && defects.length === 0, defects, engine: res.engine };
    } catch { return null; }
  };
  const HOSTED = { hostedOnly: true };
  const LOCAL = { localOnly: true };
  const STRICTER = 'Your previous reply was not valid JSON. Answer ONLY the JSON object, no prose, no fences.\n\n';

  // One part → a verdict, or { blocked } when the ladder is exhausted.
  const reviewPart = async (prompt) => {
    // Availability: hosted lanes first (a STRONGER model than the local coder), local as the live fallback.
    let side = HOSTED;
    let r = await ask(HOSTED, prompt);
    if (dead(r)) { side = LOCAL; r = await ask(LOCAL, prompt); }
    if (dead(r)) return { blocked: 'no reviewer lane answered', engine: 'unavailable' };
    let v = verdict(r);
    if (v) return v;
    // (a) ONE stricter reprompt to the SAME lane that just answered.
    const retry = await ask(side, STRICTER + prompt);
    if (!dead(retry)) { r = retry; v = verdict(r); if (v) return v; }
    // (b) ONE attempt on the OTHER side (hosted↔local), mirroring the availability fallback structure.
    const flipped = await ask(side === HOSTED ? LOCAL : HOSTED, STRICTER + prompt);
    if (!dead(flipped)) { r = flipped; v = verdict(r); if (v) return v; }
    return { blocked: 'no parseable verdict after retries', engine: `${r.engine}:unparseable` };
  };

  // Every part must be explicitly approved. A rejection anywhere rejects the change (and carries its
  // defects into the coder's retry); a blocked part blocks the whole change.
  const defects = []; let engine = '';
  for (let i = 0; i < parts.length; i++) {
    const v = await reviewPart(promptFor(parts[i], i));
    if (v.blocked) return block(parts.length > 1 ? `${v.blocked} (part ${i + 1}/${parts.length})` : v.blocked, v.engine);
    engine = v.engine;
    if (!v.ship) defects.push(...(v.defects.length ? v.defects : ['the reviewer rejected this change without naming a defect']));
  }
  return { ship: defects.length === 0, defects: defects.slice(0, 6), engine };
}
