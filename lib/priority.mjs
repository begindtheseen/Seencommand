// SEENJOBS FIRST (owner, 2026-10-21: "it should never self promote itself. it can offer ideas for seen command
// improvements when needed, like if it fails to do something it creates a ticket with what would help it,
// but its main priority is seenjobs.io").
//
// A board-meeting proposal ABOUT SEEN COMMAND ITSELF (builds the tool repo, or its subject is the tool) only
// reaches Brandon when a recorded failure is behind it — then it is a fix for something that broke, not a
// pitch. Everything else about the tool is held back (kept, visible, marked why) so the approvals queue is
// about seenjobs.io. Pure — unit tested.
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'seen', 'command', 'tool', 'app', 'add', 'make', 'fix', 'run', 'new', 'more', 'better']);
const words = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOP.has(w)));
const TOOL_SUBJECT = /\b(seen command|command center|board room|board meeting|chronos|the brain|brain (?:map|graph|vault|app)|dashboard|self[- ]?update|the builder|agents? (?:ui|tab)|this (?:tool|app|os))\b/i;

// Is this proposal about Seen Command itself? `build` is the approval's build target ('tool' | 'product' | null).
export function aboutTheTool(p, build = null) {
  if (build === 'tool') return true;
  if (build === 'product') return false;
  return p?.dept === 'platform' || TOOL_SUBJECT.test(`${p?.title || ''} ${p?.body || ''}`);
}

// The open failure (lib/failure-loop.mjs openFailures().open items) this proposal would fix, or null.
// A match needs two meaningful shared words, or the failure's id/kind named in the proposal.
export function failureBehind(p, failures = []) {
  const pw = words(`${p?.title || ''} ${p?.body || ''}`);
  for (const f of failures) {
    const text = `${f.id || ''} ${f.kind || ''} ${f.reason || ''} ${f.title || ''}`;
    if (f.id && String(p?.body || '').includes(String(f.id))) return f;
    let n = 0; for (const w of words(text)) if (pw.has(w)) n++;
    if (n >= 2) return f;
  }
  return null;
}

// Decide one proposal: { keep: true } or { keep: false, why } — held proposals stay on the record (internal).
export function seenJobsFirst(p, { build = null, failures = [] } = {}) {
  if (!aboutTheTool(p, build)) return { keep: true };
  const f = failureBehind(p, failures);
  if (f) return { keep: true, failure: f.id || null };
  return { keep: false, why: 'about Seen Command itself with no recorded failure behind it — SeenJobs comes first; tool fixes come from failures (Tickets)' };
}
