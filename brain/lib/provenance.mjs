// provenance — classify how well-grounded a fact is from its `source`, instead of taking the
// writer's word for it.
//
// THE ASYMMETRY THIS CLOSES: Chronos hardened WHO is speaking — identity comes from a credential and
// `by` is never trusted — but not HOW WELL-GROUNDED what they say is. `confidence` is written by the
// same agent that writes the claim and is validated by nothing. Measured on the live vault:
// 209 of 233 open facts are "high" (89.7%), 14 medium, 3 verified, 7 unset. A field that says "high"
// nine times out of ten cannot discriminate, so a reader sorting by it learns almost nothing.
//
// This does NOT overwrite `confidence`. Rewriting hundreds of historical rows would destroy what the
// author actually believed at the time, and the vault is append-only and bi-temporal by rule. The
// writer's self-assessment stays as data; this adds a SECOND, derived signal that nobody can assert.
//
// The classes and the weights mirror Seen's own doctrine for submissions, which the design fact
// pointed at: api/_utils/companyIntel.js SOURCE_TRUST weights a claim by WHERE IT CAME FROM
// (direct 1.0, seen_intel 1.0, ingest 0.55, reddit 0.3, web 0.5) and falls back to a 0.5 prior for
// anything it cannot place. Same idea, pointed at the thing doing the remembering.
//
// Grounded in what the corpus actually contains, not invented: of 233 open facts, 97% carry a
// `source`, and the single biggest group — 30% — is a bare wiki-link to another NOTE, i.e. a pointer
// to more prose rather than to evidence. Only 3% cite a file:line.

// Ordered strongest first. `weight` is advisory and deliberately on SOURCE_TRUST's 0..1 scale.
export const PROVENANCE = [
  {
    name: 'measured',
    weight: 1.0,
    // A number someone actually took, or an exact place in the code you can go and read.
    test: (s) => /[\w./-]+\.(?:mjs|js|ts|tsx|jsx|json|sql|md):\d+/.test(s)
      || /\b(measured|probe[ds]?|readback|read back|reproduc\w*|queried|query)\b/i.test(s)
      // A gate count like 1042/1042. The lookbehind keeps an ISO date's day range out: in
      // "2026-08-05/06" the digits are preceded by "-", and a date is not a measurement.
      || /(?<![-\d])\d+\s*\/\s*\d+/.test(s),
  },
  {
    name: 'owner',
    weight: 0.9,
    // Authoritative by fiat rather than by measurement. High because the owner DECIDES policy — but
    // it is not evidence for a factual claim, which is why it is its own class and not "measured".
    test: (s) => /\bowner\b/i.test(s),
  },
  {
    name: 'artifact',
    weight: 0.8,
    // A commit, PR or URL: not a measurement, but a fixed thing a reader can independently open.
    test: (s) => /\bhttps?:\/\//.test(s) || /\bPR #\d+/.test(s)
      // A commit-ish hash: 7-40 hex chars containing at least one a-f. Requiring a letter keeps
      // epoch timestamps and long numeric ids from reading as commits.
      || /\b(?=[0-9a-f]{7,40}\b)[0-9a-f]*[a-f][0-9a-f]*\b/.test(s),
  },
  {
    name: 'code',
    weight: 0.7,
    // A source file with no line — points at the right neighbourhood, not the exact claim.
    test: (s) => /[\w./-]+\.(?:mjs|js|ts|tsx|jsx|json|sql)\b/.test(s),
  },
  {
    name: 'note-pointer',
    weight: 0.3,
    // A bare wiki-link. The largest group in the vault, and it cites no evidence at all — it points
    // at more prose, which may itself be a note-pointer.
    test: (s) => /^\[\[[^\]]+\]\]$/.test(s.trim()),
  },
];

// The prior for a source we cannot place, mirroring SOURCE_TRUST's `?? 0.5`.
export const UNCLASSIFIED = { name: 'unclassified', weight: 0.5 };
// No source at all is strictly worse than one we merely cannot parse.
export const UNSOURCED = { name: 'unsourced', weight: 0.2 };

// Classify one fact's source string. Pure; returns { name, weight }.
export function classifyProvenance(source) {
  const s = String(source == null ? '' : source).trim();
  if (!s || s === 'null' || /^session [\d-]+$/i.test(s)) return { ...UNSOURCED };
  for (const c of PROVENANCE) if (c.test(s)) return { name: c.name, weight: c.weight };
  return { ...UNCLASSIFIED };
}

// Distribution over a set of facts, for a health verdict that can say how much of the brain is
// actually evidence-backed rather than how much of it claims to be.
export function provenanceMix(facts = []) {
  const counts = {};
  for (const f of facts) {
    const { name } = classifyProvenance(f && f.source);
    counts[name] = (counts[name] || 0) + 1;
  }
  const total = facts.length;
  const weak = (counts['note-pointer'] || 0) + (counts.unsourced || 0);
  return { total, counts, weak, evidenceBacked: (counts.measured || 0) + (counts.artifact || 0) + (counts.code || 0) };
}
