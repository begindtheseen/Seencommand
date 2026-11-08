// The operator playbook — the rules the Growth Studio plans by, each with a one-line rationale and the
// source it comes from. The plan, the calendar, the daily loop and the copywriter name the rule that drove
// every recommendation (rule ids below), so "why are we doing this?" always has an answer.
//
// Sources are well-known books, essays and regulations only. Where a rule is Seen's own (an owner
// decision or the approved Operation 50% playbook in the seen repo), the source says so.
export const RULES = {
  beachhead: {
    name: 'One beachhead first',
    rule: 'Win one small, reachable audience completely before widening: people ghosted by staffing agencies, the r/recruitinghell crowd.',
    rationale: 'A small market you can dominate beats a big one where you are noise; word of mouth only works inside a dense group.',
    source: 'Geoffrey A. Moore, "Crossing the Chasm" (1991); Peter Thiel, "Zero to One" (2014); owner decision 2026-07-04 (beachhead)',
  },
  dont_scale: {
    name: "Do things that don't scale",
    rule: 'Recruit the first 100 users by hand: personal replies, one-to-one DMs to people who publicly posted a ghosting story, founder answers every comment.',
    rationale: 'Early users come from effort, not from a launch; hand-recruiting also teaches you what they actually need.',
    source: 'Paul Graham, "Do Things That Don\'t Scale" (paulgraham.com, 2013)',
  },
  activation_first: {
    name: 'Activation before acquisition',
    rule: 'Do not buy or chase more traffic until a new visitor reliably reaches the first useful moment (checks a company, tracks an application, or reports an outcome).',
    rationale: 'Traffic poured into a leaky first visit is wasted; fixing the first visit multiplies every channel at once.',
    source: 'Dave McClure, "Startup Metrics for Pirates" (AARRR, 2007); Sean Ellis & Morgan Brown, "Hacking Growth" (2017)',
  },
  weekly_retention: {
    name: 'Check retention every week',
    rule: 'Every Monday: compare this week to last on users, weekly active, reports, and who came back. Growth that does not retain is not growth.',
    rationale: 'A weekly number you look at is a number you improve; cohorts show whether the product is getting more useful.',
    source: 'Alistair Croll & Benjamin Yoskovitz, "Lean Analytics" (2013); Paul Graham, "Startup = Growth" (2012)',
  },
  founder_content: {
    name: 'Founder-led content on a fixed cadence',
    rule: 'One weekly Ghost Report and two short clips, posted by Brandon as himself, every week, whether or not the last one landed.',
    rationale: 'A real founder keeping receipts in public is the trust moat; a fixed cadence gives 52 shots a year instead of a few launches.',
    source: 'Seen playbook (CONTENT_ENGINE.md, WEEKLY_ROUTINE.md: "the cadence IS the product of this plan"); Kevin Kelly, "1,000 True Fans" (2008)',
  },
  kill_gates: {
    name: 'Dated kill-gates',
    rule: 'Every bet gets a number and a date. Hit it → double down. Miss it twice → stop and move the effort to what is working.',
    rationale: 'Without a dated gate, a dead channel keeps eating hours out of loyalty; a scheduled pivot-or-persevere check prevents that.',
    source: 'Eric Ries, "The Lean Startup" (2011, pivot-or-persevere); Seen playbook 90_DAY_CALENDAR.md (G1–G6)',
  },
  compounding_seo: {
    name: 'Build assets that compound',
    rule: 'Prefer work that keeps paying: company pages with real report counts, the Staffing Agency Ghost Index, the weekly Ghost Report archive — pages people search for.',
    rationale: 'A post decays in days; a useful page earns search and AI-answer traffic every day after it ships.',
    source: 'Google Search Central, "Creating helpful, reliable, people-first content"; owner decision 2026-07-04 (Ghost Index as hero asset)',
  },
  focus_channel: {
    name: 'Test few channels, then focus',
    rule: 'Run small tests in a few channels, then put most effort into the one that moves users. Organic first; paid only after organic proves the message.',
    rationale: 'Most startups have one channel that works far better than the rest; spreading thin finds none.',
    source: 'Gabriel Weinberg & Justin Mares, "Traction" (2015, the Bullseye framework)',
  },
  promotable: {
    name: 'Promotable by design',
    rule: 'Make assets a creator can cite to look smart to their own audience: a linked number with its sample size, a lookup, a ranking, a card.',
    rationale: 'People share what makes them look good and helps others (social currency, practical value); creators come when the asset does their work.',
    source: 'Jonah Berger, "Contagious" (2013, STEPPS)',
  },
  distinctive_assets: {
    name: 'Consistent, distinctive brand assets',
    rule: 'Same colors, type, wordmark and phrasing everywhere ("Check if they ghost before you apply"), so every post builds the same memory.',
    rationale: 'Brands grow by being easy to recognise and recall; changing the look every post throws that away.',
    source: 'Byron Sharp, "How Brands Grow" (2010)',
  },
  positioning: {
    name: 'Own one category',
    rule: 'Position against the alternatives people use today (review sites, job boards, trackers, venting threads) and name the category Seen leads: the public response record of employers.',
    rationale: 'A clear "it is the X for Y" frame tells people why Seen is different in one breath — not a needle in the haystack.',
    source: 'April Dunford, "Obviously Awesome" (2019); Al Ries & Jack Trout, "Positioning" (1981)',
  },
  one_percent: {
    name: '1% better every day',
    rule: 'Every day, ship ONE small concrete improvement (product, content, SEO, data quality or distribution) sized for that day.',
    rationale: 'Small daily gains compound (1.01^365 ≈ 37×); a streak of small wins beats occasional big pushes.',
    source: 'James Clear, "Atomic Habits" (2018)',
  },
  honest_numbers: {
    name: 'No invented numbers',
    rule: 'Every number comes from Seen\'s live data with its sample size and a source link; when data is thin, say so ("6 reports — low confidence").',
    rationale: 'One caught fabrication kills a trust brand; honest-small ("3 reports so far — help make it 300") outperforms fake scale.',
    source: 'Seen strategy (Public Trust Language) and playbook CONTENT_ENGINE.md "What NOT to do"',
  },
  disclosure: {
    name: 'Disclose every connection',
    rule: 'Brandon says he is the founder whenever Seen comes up; any creator who is paid or given Pro says so clearly; no fake reviews or testimonials.',
    rationale: 'It is the law for endorsements and the culture of Reddit; undisclosed promotion is the fastest way to lose a community.',
    source: 'FTC Guides Concerning the Use of Endorsements and Testimonials (16 CFR Part 255); FTC rule on consumer reviews and testimonials (16 CFR Part 465, 2024)',
  },
  platform_rules: {
    name: 'Respect each platform\'s rules',
    rule: 'Reddit: value first, follow each subreddit\'s posted self-promotion rules, at most one link post per subreddit per week, no cross-posting the same link to many subs in a day.',
    rationale: 'Communities remember; a ban in r/recruitinghell would close the beachhead.',
    source: 'Reddit Content Policy + each subreddit\'s rules (check the sidebar before posting); Seen playbook WEEKLY_ROUTINE.md "Rules of engagement"',
  },
  email_law: {
    name: 'Email by the rules',
    rule: 'Every email has an honest subject, who it is from, a working unsubscribe, and Seen\'s postal address.',
    rationale: 'Required for commercial email in the US, and it keeps the domain out of spam folders.',
    source: 'CAN-SPAM Act (2003)',
  },
  money_never_scores: {
    name: 'Money never changes a score',
    rule: 'No ad, sponsorship or employer deal may change, hide or soften a grade — and copy must never imply it could.',
    rationale: 'The grade is the product; if it can be bought, nothing Seen says is worth sharing.',
    source: 'Owner decision 2026-07-04 (employer-side revenue: money NEVER changes a score)',
  },
};

export function rule(id) { const r = RULES[id]; if (!r) throw new Error(`unknown playbook rule: ${id}`); return { id, ...r }; }
/** "Rule: One beachhead first — <rationale>" — the one-line citation attached to a recommendation. */
export function cite(id) { const r = rule(id); return `${r.name} — ${r.rationale}`; }
export function rulesList() { return Object.keys(RULES).map(rule); }
