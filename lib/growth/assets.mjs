// "Promotable by design": the assets that make a creator look good to their own audience, and the weekly
// creator-ready story angles built on them. Exported for the Creator Library's discovery to match
// creators to (shareableAssets() + storyAngles(week)). An angle only carries a number when a real
// callout (lib/growth/data.mjs) backs it; otherwise it is a no-number angle and says what data it needs.
import { config } from '../config.mjs';
import { rule } from './rules.mjs';

/** Every asset a creator can cite or send their audience to, most promotable first. */
export function shareableAssets(base = config.seenBaseUrl()) {
  return [
    { id: 'agency-index', name: 'Staffing Agency Ghost Index', url: `${base}/agencies`, kind: 'ranking', priority: 1, phase: 'atomic',
      creatorGets: 'A ranked, linkable list of major agencies by applicant-reported outcomes — a ready-made "which agencies ghost?" segment.',
      audienceGets: 'Check an agency before giving it another week.', fits: ['staffing', 'recruiting', 'job-search', 'hourly-jobs'], rule: 'promotable' },
    { id: 'company-lookup', name: '"Is this company ghosting?" lookup', url: `${base}/companies`, kind: 'lookup', priority: 2, phase: 'atomic',
      creatorGets: 'A one-link call to action that is useful to every viewer ("look up the company before you apply").',
      audienceGets: 'A grade with its report count, or an honest "not enough data yet".', fits: ['job-search', 'career-advice', 'layoffs', 'hourly-jobs'], rule: 'promotable' },
    { id: 'company-page', name: 'Citable company pages', url: `${base}/company/<name>`, kind: 'citation', priority: 3, phase: 'atomic',
      creatorGets: 'A number with its sample size and a link to cite, so their claim survives a skeptical comment section.',
      audienceGets: 'The response record for that employer.', fits: ['career-advice', 'recruiting', 'big-tech', 'retail'], rule: 'honest_numbers' },
    { id: 'ghost-report', name: 'The weekly Ghost Report', url: `${base}/ghost-report`, kind: 'data story', priority: 4, phase: 'loop',
      creatorGets: 'A fresh, dated data story every week — content they did not have to research.',
      audienceGets: 'What changed this week in who answers applicants.', fits: ['career-advice', 'job-search', 'news'], rule: 'founder_content' },
    { id: 'outcome-card', name: 'Outcome cards', url: `${base}/tracker`, kind: 'shareable card', priority: 5, phase: 'loop',
      creatorGets: 'A format their audience can make and share themselves ("post your ghosted card").',
      audienceGets: 'A card of their own outcome — hired, rejected or ghosted — that also warns the next applicant.', fits: ['job-search', 'layoffs', 'storytime'], rule: 'promotable' },
    { id: 'compare', name: 'Side-by-side compare', url: `${base}/compare`, kind: 'comparison', priority: 6, phase: 'loop',
      creatorGets: '"X vs Y: who actually answers applicants?" — a clean versus format.',
      audienceGets: 'Two employers\' response records side by side.', fits: ['career-advice', 'big-tech', 'retail'], rule: 'promotable' },
    { id: 'ghosted-landing', name: 'The /ghosted page', url: `${base}/ghosted`, kind: 'landing', priority: 7, phase: 'atomic',
      creatorGets: 'A soft landing for "I got ghosted" audiences — empathy first, the record second.',
      audienceGets: 'A place to put their ghosting on the record in about two minutes.', fits: ['storytime', 'job-search', 'staffing'], rule: 'dont_scale' },
  ];
}

// Angle templates. `needs` = what real data the angle requires; a template whose data is missing is still
// offered as a no-number angle (story-first) — never filled with a made-up figure.
const ANGLES = [
  { id: 'agency-before-you-call', title: 'Check the agency before the "quick call"', needs: 'agency',
    hook: (c) => c ? `Before you hop on another "quick call" with ${c.name}: applicant reports on Seen put their ghost rate at ${c.ghostPct}% (${c.reports} reports).` : 'Before you hop on another "quick call" with a staffing agency, look up its response record.',
    fits: ['staffing', 'recruiting', 'job-search'], assets: ['agency-index', 'company-page'], pillar: 'agency-index' },
  { id: 'honest-small', title: 'Building the record in public', needs: null,
    hook: () => 'I\'m building a public record of which employers answer applicants. Here\'s what it shows so far — and why the small numbers are labelled small.',
    fits: ['founder', 'career-advice', 'job-search'], assets: ['agency-index', 'ghost-report'], pillar: 'build-in-public' },
  { id: 'who-answers', title: 'The employers that actually answer', needs: 'responsive',
    hook: (c) => c ? `Not every employer ghosts. ${c.name} answered in ${c.responsePct}% of ${c.reports} applicant reports on Seen.` : 'Not every employer ghosts — here is how to find the ones that answer before you apply.',
    fits: ['career-advice', 'hourly-jobs', 'retail'], assets: ['company-lookup', 'compare'], pillar: 'credit-the-good' },
  { id: 'lookup-before-apply', title: 'The 10-second check before you apply', needs: null,
    hook: () => 'The 10-second check before any application: does this company actually answer applicants?',
    fits: ['job-search', 'hourly-jobs', 'layoffs'], assets: ['company-lookup'], pillar: 'how-to' },
  { id: 'ghost-ranking', title: 'Which big names ghost the most (by reports)', needs: 'ghosting',
    hook: (c) => c ? `${c.name}: ${c.ghostPct}% ghost rate across ${c.reports} applicant reports. The full ranking is public.` : 'A public ranking of employers by applicant-reported ghosting is being built — here is how it works.',
    fits: ['career-advice', 'news', 'staffing'], assets: ['agency-index', 'company-page'], pillar: 'data-story' },
  { id: 'card-it', title: 'Put your ghosting on the record', needs: null,
    hook: () => 'Ghosted after the interviews? Put it on the record — the card takes two minutes and warns the next applicant. (Tell your own real story, or none.)',
    fits: ['storytime', 'job-search', 'layoffs'], assets: ['outcome-card', 'ghosted-landing'], pillar: 'outcome-card' },
];

/**
 * Creator-ready angles for a plan week. `data` = callouts() result (or null). Rotates through the templates
 * so each week leads with a different angle; every angle lists who it fits, the assets, the rule behind it
 * and the evidence (callout) or the fact that it has none.
 */
export function storyAngles(week = 1, data = null) {
  const w = Math.max(1, Number(week) || 1);
  const pick = (needs, i) => {
    if (!data) return null;
    const list = needs === 'agency' ? data.agencies : needs === 'responsive' ? data.mostResponsive : needs === 'ghosting' ? data.mostGhosting : null;
    return list && list.length ? list[(w + i) % list.length] : null;
  };
  const start = (w - 1) % ANGLES.length;
  return Array.from({ length: 4 }, (_, k) => {
    const a = ANGLES[(start + k) % ANGLES.length];
    const c = a.needs ? pick(a.needs, k) : null;
    return { id: `${a.id}-w${w}`, angle: a.id, week: w, title: a.title, hook: a.hook(c), pillar: a.pillar, fits: a.fits, assets: a.assets,
      evidence: c ? { line: c.line, source: c.sourceLine, url: c.url, reports: c.reports, confidence: c.confidence } : null,
      needsData: a.needs && !c ? `needs ${a.needs} data from Seen's leaderboard (none reachable or none past the grade gate)` : null,
      rule: rule('promotable') };
  });
}
