// Title similarity — the deterministic duplicate detector. The agenda model rewords the same work
// ("Fix Ghost Report Table Alignment" → "Investigate and Optimize Ghost Report Table Alignment"),
// so exact-key dedupe missed twins and Brandon got triplicate tasks. This compares the SUBJECT of two
// titles: generic action words are stripped, the remaining tokens are Jaccard-compared.

const GENERIC = new Set(('fix fixes fixed build builds building built implement implements implementation create creates '
  + 'creating add adds adding develop develops developing development review reviews reviewing merge merges merging '
  + 'plan plans planning update updates updating improve improves improving enhance enhances enhancing investigate '
  + 'investigating optimize optimizes optimizing conduct conducting generate generating automate automating automation '
  + 'weekly daily new the a an and or for in of on to with via from into this that our your feature pr task issue '
  + 'proposal draft report script system process').split(' '));

// The meaningful subject tokens of a title.
export function subjectTokens(title) {
  return new Set(String(title || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')          // strip [dept] prefixes
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC.has(w)));
}

// Jaccard similarity of the two titles' subject tokens (0..1).
export function titleSimilarity(a, b) {
  const A = subjectTokens(a), B = subjectTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Are these two titles the same work, reworded? Threshold tuned on the real duplicate clusters
// ("Error Monitoring and Logging Feature PR" vs "Review and Merge Error Monitoring and Logging
// Feature PR" vs "Error Monitoring and Logging Feature PR Build" must all match).
export function sameWork(a, b, threshold = 0.5) {
  return titleSimilarity(a, b) >= threshold;
}

// First existing title that matches `title` as the same work, or null.
export function findDuplicate(title, existingTitles, threshold = 0.5) {
  for (const t of existingTitles) if (sameWork(title, t, threshold)) return t;
  return null;
}

// A CONCRETE ANCHOR: a path-ish token (contains a slash — app/employers/page.tsx, scripts/foo.mjs,
// api/refresh-jobs) OR a file-ish token (command-center.html, run.mjs). Its presence is the machine
// proof that an engineering proposal named a real target the coder can open, not a whole feature — the
// decomposition contract (PR #105). It also selects the coding LANE in the builder: a task WITH an
// anchor is a patch the local SEARCH/REPLACE coder can land; a task WITHOUT one is feature-shaped and
// belongs to the agentic loop that grounds → plans → implements multi-file. Lives here (not run.mjs)
// so engine/builder.mjs can read it without importing the meeting engine; run.mjs re-exports it.
export const CONCRETE_ANCHOR = /[\w.-]+\/[\w./-]+|\b[\w-]+\.(?:html?|tsx?|jsx?|mjs|cjs|css|sql|md|json|yml)\b/;
