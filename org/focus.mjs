// Focus / directive model — you set where the company points; every department finds its place.
// A focus re-orients the whole org: some departments LEAD, some SUPPORT, some HOLD (stand down so
// they don't fight the priority). This is what makes the Board Room a real conversation: you state
// the goal, the team re-aligns around it.
//
// Current default = 'users' (owner: "getting users is most important right now. Not paid. Just users.")

export const FOCUSES = {
  users: {
    id: 'users', title: 'Raw user growth', emoji: '📈',
    northStar: 'Get users. Not paid — just signups. Everything bends to this.',
    dept: {
      growth:      { role: 'lead',    move: 'More genuinely helpful community posts + Ghost Report reach; earn signups by being useful.' },
      product:     { role: 'lead',    move: 'Kill signup friction; ship activation (fast first-value), not paywalled features.' },
      strategy:    { role: 'lead',    move: 'The game plan IS a user-acquisition plan; assign it across the depts.' },
      data:        { role: 'support', move: 'Instrument the signup funnel end-to-end; report signups/day as the #1 metric.' },
      reliability: { role: 'support', move: 'Keep the site fast + cheap under the influx; no scaling surprises.' },
      platform:    { role: 'support', move: 'Keep the OS itself smooth so nothing slows the team.' },
      revenue:     { role: 'hold',    move: 'Stand down on paywall pushes — do NOT gate growth. Keep billing healthy only.' },
    },
  },
  revenue: {
    id: 'revenue', title: 'Revenue', emoji: '💰',
    northStar: 'Turn interviews into Interview Prep sales. One-time revenue in the last 30 days is the metric.',
    dept: {
      revenue:     { role: 'lead',    move: 'Offer placement at the interview moment, checkout fixes, employer sales — full press.' },
      data:        { role: 'lead',    move: 'Own the revenue funnel (tracked → interview → offer → checkout → purchase); find and close the leak.' },
      strategy:    { role: 'lead',    move: 'Monetization game plan.' },
      growth:      { role: 'support', move: 'Target higher-intent segments; content that pulls buyers.' },
      product:     { role: 'support', move: 'Ship conversion-critical features; tighten the paywall UX.' },
      reliability: { role: 'support', move: 'Payments + webhooks rock-solid.' },
      platform:    { role: 'support', move: 'Keep the OS smooth.' },
    },
  },
  retention: {
    id: 'retention', title: 'Retention / activation', emoji: '🔁',
    northStar: 'Keep and activate the users we have — repeat value, less churn.',
    dept: {
      product:     { role: 'lead',    move: 'Onboarding + habit loops; get users to repeat value fast.' },
      data:        { role: 'lead',    move: 'Cohort retention + reactivation triggers.' },
      strategy:    { role: 'lead',    move: 'Retention game plan.' },
      growth:      { role: 'support', move: 'Re-engagement content + win-back.' },
      revenue:     { role: 'support', move: 'Retain paid; cut churn/dunning.' },
      reliability: { role: 'support', move: 'Reliability IS retention — no outages.' },
      platform:    { role: 'support', move: 'Keep the OS smooth.' },
    },
  },
  reliability: {
    id: 'reliability', title: 'Reliability & cost', emoji: '🛡️',
    northStar: 'Rock-solid + cheap. Don’t let infra or a vendor limit us.',
    dept: {
      reliability: { role: 'lead',    move: 'Uptime, scaling, Supabase advisors, cut spend + lock-in.' },
      platform:    { role: 'lead',    move: 'Harden the OS; auto-fix and self-heal.' },
      product:     { role: 'support', move: 'Fix reliability-critical bugs first.' },
      data:        { role: 'support', move: 'Watch error/anomaly signals.' },
      growth:      { role: 'hold',    move: 'Ease off volume until the base is solid.' },
      revenue:     { role: 'support', move: 'Keep billing dependable.' },
      strategy:    { role: 'support', move: 'Stability-first game plan.' },
    },
  },
};

export const DEFAULT_FOCUS = 'users';
export const ROLE_LABEL = { lead: 'LEAD', support: 'SUPPORT', hold: 'HOLD' };

// The cap on a custom focus title. This is not just a UI concern: the title is what the board
// meeting records into the shared brain as `Seen Command · current_focus` (engine/run.mjs →
// lib/brain.mjs recordBoardMeeting), so whatever survives this clamp becomes the durable fact.
export const FOCUS_TITLE_MAX = 280;

// Clamp a free-text focus to a title that still reads as a sentence.
//
// The old cap was a hard `.slice(0, 80)`, which cut mid-word — a real directive was stored, and
// recorded into the brain, as "… instead of being fa". A fact you can't read is worse than no fact.
// Now: 280 chars, cut on a word boundary, and an ellipsis ONLY when the text is genuinely longer
// (anything at or under the cap is returned untouched, so short titles never gain a "…").
export function clampFocusTitle(text, max = FOCUS_TITLE_MAX) {
  const s = String(text || '').trim().replace(/[."'\s]+$/, '');
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1); // leave room for the one-character ellipsis
  const space = head.lastIndexOf(' ');
  // Fall back to the hard cut only when there is no sensible word break to land on (one long token).
  const cut = space > max * 0.6 ? head.slice(0, space) : head;
  return cut.replace(/[\s.,;:!?'"“”‘’—–-]+$/, '') + '…';
}

// A CUSTOM focus — any goal Brandon types that isn't one of the four presets (e.g. "expanding Seen
// Command capabilities"). Strategy leads, everyone else supports it. Stored on state.customFocus.
export function buildCustomFocus(text) {
  const title = clampFocusTitle(text) || 'Custom focus';
  const dept = {};
  for (const id of ['growth', 'product', 'strategy', 'data', 'reliability', 'revenue', 'platform']) {
    dept[id] = { role: id === 'strategy' ? 'lead' : 'support', move: `Advance "${title}".` };
  }
  return { id: 'custom', title, emoji: '🎯', northStar: title, dept, custom: true };
}

// The active focus object for a state — a custom focus if one is set, else the preset by focusId.
export function resolveFocus(state) {
  if (state && state.customFocus && state.customFocus.title) return state.customFocus;
  return FOCUSES[(state && state.focusId) || DEFAULT_FOCUS] || FOCUSES[DEFAULT_FOCUS];
}

// Map a free-text directive to the nearest focus (P1 — before the live model does true dialogue).
export function focusFromText(text) {
  const t = String(text || '').toLowerCase();
  if (/pa(y|id)|revenue|mrr|money|convert|sales/.test(t)) return 'revenue';
  if (/reten|activat|churn|keep|onboard|engage/.test(t)) return 'retention';
  if (/reliab|uptime|cost|scal|infra|stable|stability/.test(t)) return 'reliability';
  if (/user|signup|sign up|grow|traffic|acquisition|audience/.test(t)) return 'users';
  return null;
}
