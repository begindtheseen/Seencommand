// handoff-detect — spot a timeline episode that is really a message to another agent.
//
// Why: identical content is durable or effectively deleted depending only on which container it
// lands in. A FACT surfaces in fact search and briefings; a timeline EPISODE does not. So a handoff
// addressed to another agent and written into an episode is invisible to its addressee even though
// the write returned ok:true. That happened for real — a session flagged another agent's stale fact
// only inside a timeline entry, and the addressee, which reads facts, would never have seen it.
//
// The write API gave no signal: append_timeline and record_fact both return ok:true and neither
// knows the content was addressed to someone. This adds the missing signal.
//
// DELIBERATELY A WARNING, NOT AN AUTO-WRITE. Minting a companion fact would require inventing a
// note path, subject and predicate from prose — which is exactly how the stranded-facts-at-root
// class was created (a caller's sentence landed in the `note` argument and the fact became
// unreadable forever). Guessing structure from narrative is the bug, not the fix. The caller is
// told; the caller decides.
//
// Tuned for PRECISION over recall. A detector that fires on every entry mentioning another agent
// is alarm fatigue, and these entries mention each other constantly in ordinary narration. Only
// ADDRESSING constructs count — naming an agent while describing what it did must not fire.

const CLIENT = String.raw`(?:claude-[a-z][a-z0-9-]*|codex)`;

const SIGNALS = [
  // An explicit banner: "HANDOFF:", "HANDOFF FOR x", "HANDOFF TO x". Uppercase only, because prose
  // uses the lowercase word constantly. The `.md` exclusion is not hypothetical — every session
  // reads HANDOFF.md at orientation and says so, and a bare /\bHANDOFF\b/ fired on exactly that in
  // real timeline data, which would have made this warning noise on almost every entry.
  { name: 'handoff-banner', re: /\bHANDOFF\b(?!\.md)(?=\s*(?::|FOR\b|TO\b))/ },
  // "handoff for claude-brain", "handoff to codex"
  { name: 'handoff-for', re: new RegExp(String.raw`\bhand-?off\s+(?:for|to)\s+${CLIENT}`, 'i') },
  // "handing off to codex", "handed off to claude-seenjobs"
  { name: 'handing-off', re: new RegExp(String.raw`\bhand(?:ing|ed)?\s+off\s+to\s+${CLIENT}`, 'i') },
  // "FOR claude-brain" as an addressee banner (uppercase FOR is the addressing form)
  { name: 'for-addressee', re: new RegExp(String.raw`\bFOR\s+${CLIENT}\b`) },
  // "over to claude-brain"
  { name: 'over-to', re: new RegExp(String.raw`\bover to\s+${CLIENT}\b`, 'i') },
  // A direct request aimed at another agent: "claude-seenjobs should run ...", "codex must ..."
  { name: 'request-to-agent', re: new RegExp(String.raw`\b${CLIENT}\s+(?:should|must|needs? to|please)\b`, 'i') },
];

// Returns { handoff: boolean, signals: string[] }. Pure: no I/O, no state, safe to call on any text.
export function detectHandoff({ heading = '', text = '' } = {}) {
  const hay = `${heading}\n${text}`;
  const signals = SIGNALS.filter((s) => s.re.test(hay)).map((s) => s.name);
  return { handoff: signals.length > 0, signals };
}

// The sentence shown to a caller whose episode looks like a handoff. Names the consequence and the
// remedy rather than just flagging.
export const HANDOFF_WARNING =
  'This episode looks like a handoff addressed to another agent (matched: %s). '
  + 'A timeline episode is NARRATIVE — it does not surface in fact search or briefings, so the '
  + 'addressee will not see it. Record the handoff as a FACT with brain_add_fact; keep this entry '
  + 'as the narrative copy.';

export function handoffWarning(signals = []) {
  // A function replacement, not a string one: String.replace treats $&, $', $` and $1 in a
  // replacement STRING as special patterns. Signal names are constants today, but a future one
  // containing '$' would silently corrupt the warning. This form has no such escape hatch.
  return HANDOFF_WARNING.replace('%s', () => signals.join(', '));
}
