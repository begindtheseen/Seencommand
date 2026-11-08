// The org chart — Seen's AI exec team. A 3-tier company: CEO/Orchestrator → C-suite department
// heads → worker agents. Tailored to what makes Seen (a hiring-intelligence SaaS) win:
// growth, product, reliability-at-low-cost, revenue, and data/intelligence.
//
// This is pure data. The orchestrator (engine/run.mjs) reads it to allocate a "board meeting" run;
// the dashboard reads it to draw the org network + live statuses. Each worker has a `charter`
// (what it owns) and `outputs` (the kind of proposal artifact it returns for approval).

export const CEO = {
  id: 'ceo',
  title: 'CEO / Orchestrator',
  layer: 'command',
  charter: "Review yesterday's completed work, allocate today across departments, enforce the "
    + 'approval gate, and write Brandon the morning debrief.',
};

export const DEPARTMENTS = [
  {
    id: 'growth',
    title: 'CMO · Growth',
    charter: 'Drive the growth plan via the channels Seen actually uses — Reddit (beachhead) + the '
      + 'Ghost Report + owned SEO/GEO content. Own the top of the funnel.',
    kpi: 'weekly community contributions (helpful posts, replies, conversations) → signups',
    workers: [
      { id: 'reddit', title: 'Reddit Marketing / Community', charter: 'Transparent, rules-respecting participation in r/recruitinghell — helpful posts, genuine replies, and opt-in conversations as the founder — the current primary channel.', outputs: 'reddit plan' },
      { id: 'ghost-report', title: 'Ghost Report Writer', charter: 'Draft the weekly intelligence brief from company_scores (the data-story content asset).', outputs: 'intel brief' },
      { id: 'seo-content', title: 'SEO / GEO Content', charter: 'Write company-page + comparison content for search and AI citations (GEO).', outputs: 'seo draft' },
      { id: 'market-research', title: 'Competitor & Market Research', charter: 'Pull competitor moves + market signals into the Knowledge Vault.', outputs: 'research memo' },
      { id: 'social', title: 'Social (dormant)', charter: 'Off by default — switch on when you decide to expand past Reddit into social.', outputs: 'social plan', dormant: true },
    ],
  },
  {
    id: 'product',
    title: 'CTO · Product & Engineering',
    charter: 'Ship new features and fix bugs on Seen (next-migration). Trace the full contract before shipping.',
    kpi: 'features shipped · bugs closed · build green',
    workers: [
      { id: 'bugfix', title: 'Bug Triage & Fix', charter: 'Triage reported/observed bugs, reproduce, and open PRs.', outputs: 'bugfix PR' },
      { id: 'feature', title: 'Feature Builder', charter: 'Build approved features end-to-end with tests.', outputs: 'feature PR' },
      { id: 'db', title: 'Database / Migrations', charter: 'Own Supabase schema + RLS: draft migrations, run advisor scans, keep prod schema clean.', outputs: 'migration draft' },
      { id: 'reviewer', title: 'Code Reviewer', charter: 'Adversarially review open PRs before merge.', outputs: 'review verdict' },
    ],
  },
  {
    id: 'reliability',
    title: 'Head of Reliability & Cost · SRE',
    charter: 'Keep Seen healthy and scalable at LOW cost and LOW external dependency. Own uptime and spend.',
    kpi: 'uptime · $/month · # external dependencies',
    workers: [
      { id: 'uptime', title: 'Uptime / Health Monitor', charter: 'Watch routes, APIs, crons, error rates, AND Supabase advisors (RLS + perf lints); flag regressions.', outputs: 'health report' },
      { id: 'cost-watchdog', title: 'Cost & Dependency Watchdog', charter: 'Guard against any vendor — especially Supabase — becoming a cost or scaling ceiling; flag lock-in and keep a low-effort exit path warm.', outputs: 'cost alert' },
      { id: 'scale', title: 'Scalability & Performance', charter: 'Find bottlenecks (DB queries, indexes, caching, cold starts) before they bite.', outputs: 'perf proposal' },
    ],
  },
  {
    id: 'revenue',
    title: 'CRO · Revenue',
    charter: 'Convert and monetize — Interview Prep ($9.99) at the interview moment, the 30-day Job Search Pass ($19.99), employer revenue. All one-time; nothing renews. Own revenue per month.',
    kpi: 'revenue (30 days) · paying customers · offer → checkout → purchase',
    workers: [
      { id: 'funnel', title: 'Conversion / Funnel', charter: 'Find and fix drop-off from tracked application → interview → Prep offer → checkout → purchase.', outputs: 'funnel experiment' },
      { id: 'pricing', title: 'Pricing / Offer', charter: 'Tune where and how Interview Prep and the Pass are offered, within the locked prices (owner decisions).', outputs: 'pricing proposal' },
      { id: 'employer-sales', title: 'Employer Sales', charter: 'Qualify + draft outreach for employer featured/verified deals.', outputs: 'sales draft' },
      { id: 'payments', title: 'Payments & Refunds', charter: 'Watch failed checkouts, refunds and disputes; keep any legacy subscriptions clean until they end.', outputs: 'dunning action' },
    ],
  },
  {
    id: 'data',
    title: 'CDO · Data & Intelligence',
    charter: 'The signal layer — pull Seen’s live admin analytics and turn raw numbers into clean signal.',
    kpi: 'outcome_rate · retention · data confidence',
    workers: [
      { id: 'kpi', title: 'KPI / Metrics', charter: 'Pull the admin-stats KPI pack (users, revenue in 30 days, the revenue funnel, AI spend) for the debrief.', outputs: 'kpi pack' },
      { id: 'retention', title: 'Retention / Cohort', charter: 'Track cohort retention + reactivation opportunities from admin data.', outputs: 'retention read' },
      { id: 'anomaly', title: 'Anomaly / Health Watch', charter: 'Flag spikes in errors, flagged users, or ghost surges from admin-stats.', outputs: 'anomaly read' },
    ],
  },
  {
    id: 'strategy',
    title: 'CSO · Strategy & Steering (War Room)',
    charter: 'The business-expert team: read all the analytics + admin, diagnose what’s really going '
      + 'on, and write the game plan for where Seen needs to steer. Assigns fixes to the other depts.',
    kpi: 'is the plan working? — progress vs. the steering plan',
    workers: [
      { id: 'diagnostician', title: 'Diagnostician', charter: 'Read admin-stats + KPIs and name what’s actually going wrong (where we’re bleeding).', outputs: 'diagnosis' },
      { id: 'gameplan', title: 'Game-Plan Architect', charter: 'Turn the diagnosis into a concrete fix plan with steps + which department owns each.', outputs: 'game plan' },
      { id: 'opportunity', title: 'Opportunity Analyst', charter: 'Find the biggest upside to double down on, grounded in the numbers.', outputs: 'opportunity memo' },
      { id: 'steering', title: 'Steering Brief', charter: 'Synthesize into one answer: where does the company need to steer this week?', outputs: 'steering brief' },
    ],
  },
  {
    id: 'platform',
    title: 'COO · Platform Reliability',
    charter: 'Keeps seenjobs.io and the machinery that feeds it (job collectors, applicant reports, deploys, '
      + 'the database, the brain) running for SeenJobs\' users. SeenJobs comes first: propose work on Seen '
      + 'Command ITSELF only to fix a recorded failure (it becomes a ticket saying what would have helped) — '
      + 'never pitch features for the tool. Reversible self-fixes auto-apply.',
    kpi: 'seenjobs.io uptime · collector success rate · failures fixed',
    workers: [
      { id: 'bughunt', title: 'Bug Hunter (QA)', charter: 'Run the board meeting + dashboard every cycle; catch broken runs, JS errors, stale data, regressions.', outputs: 'bug report' },
      { id: 'wiring', title: 'Wiring Auditor', charter: 'Find missing connections — agents with no tool, dead references, org↔memory↔dashboard gaps.', outputs: 'wiring audit' },
      { id: 'usability', title: 'Usability / UX', charter: 'Improve what the command center shows and how it flows for the owner.', outputs: 'ux proposal' },
      { id: 'maintainer', title: 'Platform Maintainer', charter: 'Maintain + refactor the OS backend (engine, memory, generators); batch small fixes into a self-improvement PR.', outputs: 'platform PR' },
    ],
  },
];

// Flat helpers.
export function allWorkers() {
  return DEPARTMENTS.flatMap((d) => d.workers.map((w) => ({ ...w, dept: d.id, deptTitle: d.title })));
}
export function departmentById(id) {
  return DEPARTMENTS.find((d) => d.id === id) || null;
}
export const ORG_SUMMARY = {
  departments: DEPARTMENTS.length,
  workers: DEPARTMENTS.reduce((n, d) => n + d.workers.length, 0),
};
