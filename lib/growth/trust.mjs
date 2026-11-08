// The trust checklist every draft passes before Brandon sees it. Unbacked claims are flagged AND removed
// from the clean text; fake urgency, superlatives, scale claims, defamation-risk words, evasion words and
// unattributed testimonials are flagged; founder disclosure, a source line for data, and the email legal
// footer are added when missing. A number is "backed" only when it is in the item's evidence (a live
// callout) or is one of Seen's product facts below — everything else that looks like a claim is removed.
// Seen's product facts a draft may state without a callout — each only in its own context ("5 reports",
// "day 7", "2 minutes", "$9.99"), so "20 users" can never ride in on the Credit Pack's "20 credits".
export const PRODUCT_FACTS = [
  { value: 5, ctx: /^\s*(\+\s*)?(first[- ]party\s+)?(applicant\s+)?reports?\b/i, what: 'grade gate: a grade needs 5 first-party reports' },
  { value: 7, ctx: /^\s*-?\s*days?\b|\bday\s*$/i, what: 'day-7 check-in' },
  { value: 14, ctx: /^\s*-?\s*days?\b|\bday\s*$/i, what: 'day-14 check-in; 14 days of Pro with Interview Prep' },
  { value: 30, ctx: /^\s*-?\s*days?\b|\bday\s*$/i, what: 'day-30 check-in; the 30-day Job Search Pass' },
  { value: 2, ctx: /^\s*minutes?\b/i, what: 'reporting takes about two minutes' },
  // Seen's prices since 2026-10-25 (Seen lib/server/creditRules.js ONE_TIME_SKUS) — both one-time, neither renews.
  { value: 9.99, money: true, what: 'Interview Prep (one-time)' }, { value: 19.99, money: true, what: '30-day Job Search Pass (one-time)' },
];
const DISCLOSE_CHANNELS = new Set(['reddit', 'linkedin', 'x', 'short-video', 'dm', 'creators']);
const COUNT_NOUN = /^(users?|people|persons?|applicants?|reports?|companies|company|employers?|agencies|agency|members?|followers?|job ?seekers?|seekers?|candidates?|times|days?|weeks?|months?|interviews?|applications?|recruiters?|subscribers?|customers?|signups?|reviews?)\b/i;

export const CHECKS = [
  { id: 'numbers', label: 'Every number is backed by live data or a product fact' },
  { id: 'superlatives', label: 'No unbacked superlatives (#1, best, only)' },
  { id: 'urgency', label: 'No fake urgency' },
  { id: 'scale', label: 'No claims of scale Seen does not have' },
  { id: 'guarantee', label: 'No guarantees' },
  { id: 'hype', label: 'No hype words' },
  { id: 'defamation', label: 'Describes reported outcomes — never calls a company a scam or fraud' },
  { id: 'evasion', label: 'No evasion language (stealth, bypass, beat the ATS)' },
  { id: 'testimonial', label: 'No unattributed quotes or testimonials' },
  { id: 'money-score', label: 'Never implies money can change a score' },
  { id: 'disclosure', label: 'Founder disclosure where the platform needs it' },
  { id: 'source', label: 'Data carries a source line' },
  { id: 'email-legal', label: 'Email has unsubscribe + postal address (CAN-SPAM)' },
  { id: 'link-policy', label: 'No link in a value-first post' },
];

const PATTERNS = {
  superlatives: /(#1\b|\bnumber one\b|\bthe best\b|\bthe only\b|\bbest-in-class\b|\bworld'?s (first|best|leading)\b|\bindustry[- ]leading\b|\bmost trusted\b)/i,
  urgency: /\b(last chance|act now|only today|ends tonight|hurry|limited[- ]time|before it'?s too late|don'?t miss out|spots? (are )?filling)\b/i,
  scale: /\b(thousands|millions|hundreds|tens of thousands) of (users|people|job ?seekers|members|applicants|customers)\b|\b(everyone|everybody) (is|uses)\b/i,
  guarantee: /\bguarantee(d|s)?\b/i,
  hype: /\b(ai-powered|revolutionary|game[- ]chang\w*|disrupt\w*|cutting[- ]edge)\b/i,
  defamation: /\b(scam(s|mers?)?|fraud(ulent|s)?|illegal|criminals?|liars?|crooks?)\b/i,
  evasion: /\b(stealth|bypass(es|ing)?|beat (the )?ats|undetectable)\b/i,
  testimonial: /["“][^"”]{8,}["”]\s*(—|-|–|said|says)\s*[A-Z][a-z]+/,
  moneyScore: /\b(pay|paid|sponsor\w*|buy|bought|purchase\w*)\b[^.]{0,40}\b(score|grade|rating|ranking)\b/i,
};
// Remove the sentences that match `bad`, keeping every other sentence and the line structure.
export function dropSentences(text, bad) {
  return String(text).split('\n').map((line) => {
    if (!line.trim()) return line;
    const parts = line.split(/(?<=[.!?])\s+/);
    const kept = parts.filter((p) => !bad(p));
    return kept.length ? kept.join(' ') : null;
  }).filter((l) => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Number tokens that read as claims (%, $, ×, or followed by a countable noun). */
export function claimNumbers(text) {
  const out = []; const re = /(\$)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(\s?%|\s?x\b|×)?/g; let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    const before = s[m.index - 1] || '';
    if (/[\w/.-]/.test(before) && !m[1]) continue; // part of a word, URL or version
    const value = Number(m[2].replace(/,/g, ''));
    const after = s.slice(m.index + m[0].length).replace(/^\s*(\+|more|new|real|honest|applicant|first[- ]party|public)?\s*/i, '');
    const isClaim = !!(m[1] || m[3] || COUNT_NOUN.test(after));
    if (isClaim) out.push({ token: m[0].trim(), value, pct: !!(m[3] && m[3].includes('%')), dollar: !!m[1], after: s.slice(m.index + m[0].length, m.index + m[0].length + 30), before: s.slice(Math.max(0, m.index - 12), m.index) });
  }
  return out;
}

/** The numbers an item's evidence backs (its callout figures). */
export function allowedNumbers(evidence) {
  const set = new Set();
  for (const e of [].concat(evidence || [])) {
    if (!e) continue;
    for (const k of ['ghostPct', 'responsePct', 'reports', 'score']) if (Number.isFinite(e[k])) set.add(e[k]);
    for (const n of claimNumbers(`${e.line || ''} ${e.source || ''}`)) set.add(n.value);
  }
  return set;
}
const isProductFact = (n) => PRODUCT_FACTS.some((f) => f.value === n.value && (f.money ? n.dollar : !n.pct && !n.dollar && (f.ctx.test(n.after) || f.ctx.test(n.before))));
/** Is this claim number backed — by the evidence, or as a product fact in its own context? */
export const backed = (n, allowed) => (allowed.has(n.value) && !n.dollar) || isProductFact(n);

/**
 * Check one draft text. ctx: { evidence, channel, format, link:boolean }. Returns { ok, flags, checklist, clean }.
 * `ok` = no blocking flag remains in `clean`.
 */
export function trustCheck(text, { evidence = null, channel = '', format = '', link = true, additions = true } = {}) {
  const flags = [];
  const allowed = allowedNumbers(evidence);
  let clean = String(text || '');
  // 1) unbacked numbers → remove the sentence that carries them
  const bad = claimNumbers(clean).filter((n) => !backed(n, allowed));
  if (bad.length) {
    flags.push({ id: 'numbers', severity: 'block', text: `Unbacked number${bad.length > 1 ? 's' : ''}: ${[...new Set(bad.map((b) => b.token))].join(', ')}`, fix: 'Removed the sentence. Use a live callout (with its sample size) or say "not enough data yet".' });
    clean = dropSentences(clean, (x) => claimNumbers(x).some((n) => !backed(n, allowed)));
  }
  // 2) wording that is removed outright
  for (const [id, re, fix] of [['superlatives', PATTERNS.superlatives, 'Removed the superlative — say what Seen does, not that it is the best.'], ['urgency', PATTERNS.urgency, 'Removed the fake urgency.'], ['scale', PATTERNS.scale, 'Removed the scale claim — use the live count or nothing.'], ['guarantee', PATTERNS.guarantee, 'Removed the guarantee.'], ['evasion', PATTERNS.evasion, 'Removed evasion language (owner decision: "Human Voice", never stealth).'], ['testimonial', PATTERNS.testimonial, 'Removed the quote — testimonials must be real, attributed and permitted.'], ['money-score', PATTERNS.moneyScore, 'Removed — money never changes a score.']]) {
    if (id === 'money-score' && /never (changes?|alters?|affects?)/i.test(clean)) continue;
    if (re.test(clean)) { flags.push({ id, severity: 'block', text: `Found: "${clean.match(re)[0]}"`, fix }); clean = dropSentences(clean, (x) => re.test(x)); }
  }
  for (const [id, re, fix] of [['hype', PATTERNS.hype, 'Replace with a plain description.'], ['defamation', PATTERNS.defamation, 'Describe reported outcomes ("62% ghost rate across 20 reports"), never a verdict on the company.']]) {
    if (re.test(clean)) { flags.push({ id, severity: id === 'defamation' ? 'block' : 'warn', text: `Found: "${clean.match(re)[0]}"`, fix }); if (id === 'defamation') clean = dropSentences(clean, (x) => re.test(x)); }
  }
  // 3) value-first items carry no link
  if (!link && /https?:\/\/|seenjobs\.io\//i.test(clean)) { flags.push({ id: 'link-policy', severity: 'block', text: 'A link in a value-first post', fix: 'Removed the link — give the value; mention Seen only if asked.' }); clean = clean.replace(/\s*\(?https?:\/\/\S+\)?/g, '').replace(/\s*seenjobs\.io\/\S*/gi, ''); }
  // 4) additions
  if (DISCLOSE_CHANNELS.has(channel) && link !== false && !/\b(founder|I built|I'?m building|I am building|I made|I run)\b/i.test(clean)) { flags.push({ id: 'disclosure', severity: 'fixed', text: 'No founder disclosure', fix: 'Added "I\'m the founder of Seen."' }); clean = `${clean.trim()}\n\n(I'm the founder of Seen.)`; }
  const usesData = evidence && claimNumbers(clean).some((n) => allowed.has(n.value) && !isProductFact(n));
  if (additions && usesData && !/(seenjobs\.io|applicant reports)/i.test(clean)) { const ev = [].concat(evidence)[0]; flags.push({ id: 'source', severity: 'fixed', text: 'A number without its source', fix: 'Added the source line.' }); clean = `${clean.trim()}\nSource: ${ev.source || 'seenjobs.io'}`; }
  if (format === 'email' && !/unsubscribe/i.test(clean)) { flags.push({ id: 'email-legal', severity: 'fixed', text: 'No unsubscribe / postal address', fix: 'Added the footer — fill in Seen\'s real postal address before sending.' }); clean = `${clean.trim()}\n\n—\nYou get this because you signed up at seenjobs.io. Unsubscribe: {unsubscribe_link} · {postal_address}`; }
  if (format === 'email' && /\{postal_address\}/.test(clean)) flags.push({ id: 'email-legal', severity: 'warn', text: 'Postal address placeholder', fix: 'Replace {postal_address} with Seen\'s real mailing address (CAN-SPAM).' });
  const failed = new Set(flags.filter((f) => f.severity !== 'fixed').map((f) => f.id));
  const checklist = CHECKS.map((c) => ({ ...c, pass: !failed.has(c.id), fixed: flags.some((f) => f.id === c.id && (f.severity === 'fixed' || f.severity === 'block')) }));
  const residual = claimNumbers(clean).filter((n) => !backed(n, allowed)).length || Object.entries(PATTERNS).some(([k, re]) => k !== 'hype' && !(k === 'moneyScore' && /never (changes?|alters?)/i.test(clean)) && re.test(clean));
  return { ok: !residual, flags, checklist, clean: clean.trim() };
}
