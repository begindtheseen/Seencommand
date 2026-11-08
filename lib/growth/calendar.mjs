// The content calendar: dated California-time items for 4–6 weeks — channel, format, pillar, hook, goal,
// who does it (Brandon's action vs drafted by the app), a status that walks idea → drafted → approved →
// scheduled → posted → measured, and the results Brandon records. Generated from the plan phase, the
// week's story angles (real callouts only) and the playbook cadence (WEEKLY_ROUTINE.md / CONTENT_ENGINE.md).
// Regenerating never touches what Brandon committed to or already posted: approved, scheduled, posted and
// measured items are kept exactly. Platform rules ride on every item and are checked for the whole plan
// (Reddit: value first, ≤1 link post per subreddit per week, no same-day cross-posting).
import { readDoc, writeDoc } from './store.mjs';
import { ptToday, addDays, mondayOf, ptInstant, daysBetween, weekdayIndex } from './pt.mjs';
import { getPlan, planWeek, phaseFor } from './plan.mjs';
import { storyAngles } from './assets.mjs';
import { laneFor, dailyHistory, CATALOG } from './daily.mjs';
import { rule } from './rules.mjs';

export const STATUSES = ['idea', 'drafted', 'approved', 'scheduled', 'posted', 'measured'];
export const KEEP_ON_REGENERATE = new Set(['approved', 'scheduled', 'posted', 'measured']);

export const SUBREDDITS = {
  'r/recruitinghell': { linkPostsPerWeek: 1, note: 'Home turf. Read the sidebar rules before any post; if self-promotion is not allowed, post the data as text or an image and put the source link in a comment only if asked (CONTENT_ENGINE.md).', verified: false },
  'r/jobs': { linkPostsPerWeek: 1, note: 'Rotate in at most monthly; value-first text post, follow the posted rules.', verified: false },
  'r/jobsearchhacks': { linkPostsPerWeek: 1, note: 'How-to angle only (the 10-second check); follow the posted rules.', verified: false },
};
export const PLATFORM_RULES = {
  reddit: ['Value first: the post must be useful with the link removed', 'Say you are the founder', 'Follow the subreddit\'s posted self-promotion rules (check the sidebar the day you post)', 'At most one link post per subreddit per week; never the same link to several subs on one day', 'Reply to every honest comment for the first two hours; do not argue'],
  linkedin: ['Founder voice, first person', 'Number + sample size + source line on every data point', 'Link in the post is fine; no engagement bait'],
  x: ['One idea per post; the thread\'s first post must stand alone', 'Source line on the data post', 'Disclose founder'],
  'short-video': ['Hook in the first 2 seconds, captions on', 'Show the real product screen; never staged numbers', 'Say "I built this" in the clip or caption'],
  email: ['Honest subject line', 'Unsubscribe link and postal address (CAN-SPAM)', 'Only to people who signed up'],
  creators: ['No payment, no script, no undisclosed perks — if Pro is given, they must say so (FTC)', 'Offer the number with its link and sample size; let them tell it their way'],
  landing: ['One promise, one action', 'No claims the page itself cannot back'],
  ad: ['Plan only — no spend without a simulation and Brandon\'s yes', 'Money never changes a score; the ad cannot imply it'],
  dm: ['Only people who publicly posted being ghosted', 'Personalise the first line; one message, no follow-up'],
};

const slot = (day, time, o) => ({ date: day, time, at: ptInstant(day, time), ...o, id: `${day}-${o.channel}-${o.format}`.replace(/[^a-z0-9-]/gi, '-').toLowerCase() });

// One week of items for plan week `w` starting Monday `mon`.
export function weekItems(w, mon, { phase, angles }) {
  const lead = angles[0], second = angles[1] || angles[0], third = angles[2] || angles[0];
  const day = (i) => addDays(mon, i);
  const items = [];
  const reportWeek = w >= 3; // CONTENT_ENGINE.md: the Ghost Report starts in phase 2 (weeks 3–5)
  if (reportWeek) {
    items.push(slot(day(1), '09:00', { channel: 'reddit', subreddit: 'r/recruitinghell', format: 'reddit-post', pillar: 'data-story', link: true, owner: 'brandon',
      hook: w <= 8 ? `I'm building a public ghost-rate index. Here's week ${w - 2} — and why the small numbers are labelled small.` : lead.hook,
      goal: 'Sessions to /agencies + reports added', ownerAction: 'Post it as yourself, reply for 2 hours', rule: 'founder_content' }));
    items.push(slot(day(1), '12:00', { channel: 'linkedin', format: 'linkedin-post', pillar: 'data-story', link: true, owner: 'brandon', hook: lead.hook, goal: 'Profile visits + sessions', ownerAction: 'Post (cross-post of the Ghost Report)', rule: 'founder_content' }));
    items.push(slot(day(2), '17:00', { channel: 'short-video', format: 'video-script', pillar: w % 2 ? 'how-to' : 'agency-index', link: false, owner: 'brandon',
      hook: w % 2 ? 'Before you spend an hour on this application: does this company even respond to people?' : second.hook, goal: 'Views → profile link clicks', ownerAction: 'Record (20–40 s, vertical, captions)', rule: 'founder_content' }));
    items.push(slot(day(4), '17:00', { channel: 'short-video', format: 'video-script', pillar: 'outcome-card', link: false, owner: 'brandon', hook: third.hook, goal: 'Views → cards made', ownerAction: 'Record clip 2', rule: 'founder_content' }));
  } else {
    items.push(slot(day(1), '09:00', { channel: 'reddit', subreddit: 'r/recruitinghell', format: 'reddit-comment', pillar: 'how-to', link: false, owner: 'brandon',
      hook: 'Answer the week\'s most common "how do I know if they will ever reply?" thread with real advice — no link.', goal: 'Trust + karma (no traffic goal)', ownerAction: 'Comment as yourself', rule: 'platform_rules' }));
    items.push(slot(day(2), '12:00', { channel: 'linkedin', format: 'linkedin-post', pillar: 'build-in-public', link: true, owner: 'brandon',
      hook: w === 1 ? 'Why I\'m building a public record of which employers answer applicants.' : 'What a public ghost record shows with only a handful of reports — and why we say so.', goal: 'First followers who care', ownerAction: 'Post as founder', rule: 'founder_content' }));
    items.push(slot(day(4), '10:00', { channel: 'dm', format: 'dm', pillar: 'agency-index', link: true, owner: 'brandon', hook: 'Ten one-to-one outreach DMs to people who publicly posted a ghosting story this week.', goal: '10 sent → reports added', ownerAction: 'Send 10 (scripts 1/2)', rule: 'dont_scale' }));
  }
  items.push(slot(day(3), '10:00', { channel: 'x', format: 'x-thread', pillar: lead.pillar, link: true, owner: 'app', hook: lead.hook, goal: 'Reposts by job-search accounts', ownerAction: 'Approve a draft, then post', rule: 'promotable' }));
  items.push(slot(day(5), '10:00', { channel: 'reddit', subreddit: 'r/recruitinghell', format: 'reddit-comment', pillar: 'how-to', link: false, owner: 'brandon', hook: 'Ten genuinely helpful comments, no links.', goal: 'Trust (no traffic goal)', ownerAction: '20 min of replies', rule: 'platform_rules' }));
  if (phase.id !== 'atomic') {
    items.push(slot(day(3), '14:00', { channel: 'creators', format: 'creator-pitch', pillar: second.pillar, link: true, owner: 'app', hook: second.hook, goal: '1 creator cites Seen', ownerAction: 'Send to 3 matching creators (Creator Library)', rule: 'promotable' }));
    items.push(slot(day(6), '08:00', { channel: 'email', format: 'email', pillar: 'data-story', link: true, owner: 'app', hook: `This week in who answers applicants: ${lead.title}.`, goal: 'Opens → company lookups', ownerAction: 'Approve and send to opted-in users', rule: 'email_law' }));
  }
  if (w % 4 === 1) items.push(slot(day(0), '11:00', { channel: 'landing', format: 'landing-headline', pillar: 'positioning', link: false, owner: 'app', hook: 'Check if they ghost before you apply.', goal: 'A/B the /ghosted headline (record which wins)', ownerAction: 'Pick one to ship', rule: 'positioning' }));
  if (phase.id === 'compound' && w % 2 === 1) items.push(slot(day(0), '15:00', { channel: 'ad', format: 'ad', pillar: lead.pillar, link: true, owner: 'app', hook: lead.hook, goal: 'Creative ready IF the paid gate opens (no spend)', ownerAction: 'Review only — spend needs a simulation', rule: 'focus_channel' }));
  return items.map((it) => ({ ...it, week: w, status: 'idea', results: null, drafts: 0, angle: (angles.find((a) => a.hook === it.hook) || {}).angle || null,
    evidence: (angles.find((a) => a.hook === it.hook) || {}).evidence || null, platformRules: PLATFORM_RULES[it.channel] || [], subredditNote: it.subreddit ? SUBREDDITS[it.subreddit]?.note : null, ruleInfo: rule(it.rule) }));
}

/** Generate `weeks` (4–6) weeks of items starting the Monday of `from` (default: this week, PT). */
export function generateCalendar({ plan = getPlan(), from = ptToday(), weeks = 6, data = null } = {}) {
  const n = Math.max(4, Math.min(6, Number(weeks) || 6));
  const mon0 = mondayOf(from); const items = [];
  for (let i = 0; i < n; i++) {
    const mon = addDays(mon0, i * 7); const w = Math.max(1, planWeek(plan, mon) || 1);
    items.push(...weekItems(w, mon, { phase: phaseFor(plan, w), angles: storyAngles(w, data) }));
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/** Platform-rule violations across a set of items (empty = clean). */
export function checkRules(items) {
  const out = [];
  const linkPosts = {};
  for (const it of items) if (it.channel === 'reddit' && it.link && it.subreddit) { const k = `${it.subreddit}|${mondayOf(it.date)}`; (linkPosts[k] ||= []).push(it); }
  for (const [k, list] of Object.entries(linkPosts)) { const [sub] = k.split('|'); const cap = SUBREDDITS[sub]?.linkPostsPerWeek ?? 1; if (list.length > cap) out.push({ rule: 'platform_rules', items: list.map((i) => i.id), problem: `${list.length} link posts to ${sub} in the week of ${k.split('|')[1]} (max ${cap})` }); }
  const sameDay = {};
  for (const it of items) if (it.channel === 'reddit' && it.link) { (sameDay[it.date] ||= new Set()).add(it.subreddit); }
  for (const [d, subs] of Object.entries(sameDay)) if (subs.size > 1) out.push({ rule: 'platform_rules', problem: `the same link posted to ${subs.size} subreddits on ${d}` });
  const byWeek = {};
  for (const it of items) if (it.channel === 'reddit') { const k = mondayOf(it.date); byWeek[k] ||= { value: 0, link: 0 }; byWeek[k][it.link ? 'link' : 'value']++; }
  for (const [k, c] of Object.entries(byWeek)) if (c.link > c.value) out.push({ rule: 'platform_rules', problem: `week of ${k}: more Reddit link posts (${c.link}) than value-first ones (${c.value})` });
  return out;
}

const EMPTY = { items: [], generatedAt: null };
export function getCalendar() { return readDoc('calendar', EMPTY); }

/**
 * Regenerate from `from` for `weeks`: items Brandon committed to or posted (approved, scheduled, posted,
 * measured) are kept exactly; a new item that would take a kept item's slot is dropped; items before
 * `from`'s week are kept as history.
 */
export function regenerateCalendar({ plan = getPlan(), from = ptToday(), weeks = 6, data = null, now = new Date() } = {}) {
  const cur = getCalendar();
  const mon0 = mondayOf(from);
  const kept = cur.items.filter((i) => KEEP_ON_REGENERATE.has(i.status) || i.date < mon0);
  const keptIds = new Set(kept.map((i) => i.id));
  const fresh = generateCalendar({ plan, from, weeks, data }).filter((i) => !keptIds.has(i.id));
  const items = [...kept, ...fresh].sort((a, b) => a.at.localeCompare(b.at));
  writeDoc('calendar', { items, generatedAt: now.toISOString(), from: mon0, weeks });
  return { items, kept: kept.length, added: fresh.length, violations: checkRules(items) };
}

export function findItem(id) { return getCalendar().items.find((i) => i.id === id) || null; }
export function updateItem(id, fn) {
  const cur = getCalendar(); const i = cur.items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  cur.items[i] = { ...cur.items[i], ...fn(cur.items[i]) };
  writeDoc('calendar', cur);
  return cur.items[i];
}

/** Move an item along idea → … → measured. Back to 'idea' resets; 'measured' needs recorded results. */
export function setStatus(id, status) {
  if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}` };
  const it = findItem(id); if (!it) return { ok: false, error: 'no such calendar item' };
  if (status === 'measured' && !it.results) return { ok: false, error: 'record the results first (impressions, sessions, comments, signups…)' };
  if (status !== 'idea' && STATUSES.indexOf(status) < STATUSES.indexOf(it.status)) return { ok: false, error: `cannot move back from ${it.status} to ${status} (reset to idea instead)` };
  return { ok: true, item: updateItem(id, () => ({ status, statusAt: new Date().toISOString() })) };
}

const RESULT_KEYS = ['impressions', 'views', 'sessions', 'upvotes', 'comments', 'shares', 'signups', 'reports'];
/** Brandon's recorded results for a posted item (numbers he read off the platform). Marks it measured. */
export function recordResults(id, results = {}) {
  const it = findItem(id); if (!it) return { ok: false, error: 'no such calendar item' };
  if (!['posted', 'measured'].includes(it.status)) return { ok: false, error: 'mark it posted first' };
  const clean = {};
  for (const k of RESULT_KEYS) if (results[k] !== undefined && results[k] !== '' && results[k] !== null) { const v = Number(results[k]); if (!Number.isFinite(v) || v < 0) return { ok: false, error: `${k} must be a number ≥ 0` }; clean[k] = Math.round(v); }
  if (results.notes) clean.notes = String(results.notes).slice(0, 600);
  if (!Object.keys(clean).length) return { ok: false, error: `record at least one of ${RESULT_KEYS.join(', ')}` };
  return { ok: true, item: updateItem(id, () => ({ results: { ...clean, recordedAt: new Date().toISOString() }, status: 'measured' })) };
}

/** Calendar for the UI: days of a week with items + the 1%-a-day lane. */
export function calendarWeek({ from = ptToday(), plan = getPlan() } = {}) {
  const mon = mondayOf(from); const cal = getCalendar(); const daily = dailyHistory();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i); const rec = daily[d];
    const item = rec ? CATALOG.find((c) => c.id === rec.itemId) : null;
    return { date: d, weekday: weekdayIndex(d), items: cal.items.filter((x) => x.date === d).sort((a, b) => a.time.localeCompare(b.time)),
      daily: rec ? { title: rec.title, lane: rec.lane, status: rec.status, minutes: item?.minutes || null } : { lane: laneFor(d), status: daysBetween(ptToday(), d) > 0 ? 'upcoming' : 'not opened' } };
  });
  return { weekStart: mon, week: planWeek(plan, mon), days, generatedAt: cal.generatedAt, violations: checkRules(cal.items) };
}
