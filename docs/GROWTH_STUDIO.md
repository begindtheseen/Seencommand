# Growth Studio

The marketing team for seenjobs.io inside Seen Command: a plan to 1,000 users checked every week against
**real** admin-stats numbers, a dated content calendar with trust-checked copy, a zero-cost ad designer, the
brand kit, positioning, creator assets, the 1%-a-day loop and a paid-ads plan for later. Its first priority
is seenjobs.io; every rule it plans by is written down with a rationale and a source (`lib/growth/rules.mjs`).

Built on the approved Operation 50% playbook in the seen repo (`playbook/`, `SEEN_STRATEGY.md`) and the
locked owner decisions of 2026-07-04: beachhead = people ghosted by staffing agencies / r/recruitinghell;
the Staffing Agency Ghost Index (/agencies) is the hero asset; money never changes a score.

## What is where

| Piece | File | What it does |
|---|---|---|
| Playbook rules | `lib/growth/rules.mjs` | 17 operator rules (beachhead, don't scale, activation first, weekly retention, founder cadence, dated kill-gates, compounding assets, …), each with a one-line rationale and its source. Everything else cites them by id. |
| Brand kit | `lib/growth/brand.mjs` | Positioning, segments + pains, promise, proof points Seen can back up (each says what backs it), voice, words to use/avoid, trust principles, visual tokens (from seenjobs.io's own CSS). Editable; every save is a new version in `data/growth/brand.json` + a brain pointer `growth:brand · current-version`. |
| Positioning | `lib/growth/positioning.mjs` | Glassdoor, Indeed, Blind, Fishbowl, LinkedIn, Teal/Huntr/Simplify, r/recruitinghell: what each does well, the gap, Seen's line. The category Seen owns: **the public response record of employers**. Competitor descriptions are marked `verified: false` (our reading, not checked this session). |
| Plan to 1,000 | `lib/growth/plan.mjs` | 3 phases (Atomic network → Beachhead loop → Compounding) over 26 weeks; weekly user / paid / MRR targets (`planTargets()`); channels (organic first); the owner's weekly time budget; dated gates (the playbook's G1–G6 at day 90 + the user milestones). `checkWeek()` compares with admin-stats and says on-track / behind / off-track / unknown and what to change, naming the rule. |
| Live callouts | `lib/growth/data.mjs` | Seen's public leaderboard (the rows /agencies reads; only companies past the grade gate) → citable lines with sample size, the SEEN_STRATEGY confidence label, the page to link and an as-of date. Cached 1 h. No reachable data = no numbers. |
| Promotable assets | `lib/growth/assets.mjs` | `shareableAssets()` (agency index, lookup, company pages, Ghost Report, outcome cards, compare, /ghosted) and `storyAngles(week, data)` — four creator-ready angles a week, carrying evidence only when a real callout backs them. For the Creator Library to match creators to. |
| 1% a day | `lib/growth/daily.mjs` | One small improvement per California day by lane (Mon data · Tue content · Wed SEO · Thu product · Fri/Sat distribution · Sun content; behind plan → more distribution), streak + best + "compounded" (1.01^n), weekly review of what moved in the real snapshots. |
| Calendar | `lib/growth/calendar.mjs` | 4–6 weeks of dated PT items (channel, format, pillar, hook, goal, who does it, status idea → drafted → approved → scheduled → posted → measured, results Brandon records). Ghost Report from week 3 (playbook). Regenerate keeps approved/scheduled/posted/measured items. Platform rules ride on each item; `checkRules()` enforces ≤1 link post per subreddit per week, no same-day cross-posting, value posts ≥ link posts. |
| Copywriter | `lib/growth/copy.mjs` + `lib/growth/trust.mjs` | 3 variants (data-first / story-first / question-first) for Reddit post + title, Reddit comment, short-video script (hook/beats/CTA), LinkedIn, X thread, email, landing headline, ad, creator pitch, DM — each with "why this works" + its rule. The trust checklist removes unbacked numbers (a number is backed only by the item's live callout or a product fact in its own context), superlatives, fake urgency, scale claims, guarantees, evasion words, unattributed quotes, money-for-score; flags defamation risk and hype; adds founder disclosure, the source line and the CAN-SPAM footer. A model rewrite (optional, `reason()`) goes through the same checklist. Approvals are remembered (style counts per format reorder future drafts; examples ride in the prompt; brain pointer `growth:copy · approved-<format>`). |
| Ad designer | `lib/ui/growth-design.js` | Canvas 2D, five sizes (1080×1080, 1080×1350, 1080×1920, 1200×628, 1500×500), five templates (data callout, agency leaderboard, quote/statement, headline + CTA, 3 steps). Text is fitted (shrink → wrap → ellipsize), blocks are stacked and shrunk together so nothing reaches the footer, every data card has a source line, stories keep clear of the top 13% / bottom 18%. Sample data renders with a "SAMPLE LAYOUT — NOT REAL DATA" stamp and cannot be saved to the library. PNG download + library. |
| Paid plan | `lib/growth/ads.mjs` | A plan only — no accounts, no spend. Readiness gate (G2 hit + activation measured), channels in order, small stepped monthly budget tranches, target CPA from real paid share × price (unknown until there are paying users), kill/scale rules relative to Seen's own numbers, creative matrix with UTMs, and a ready `POST /api/simulate` body per tranche. |
| Meeting block | `lib/growth/meeting.mjs` | `growthMeetingBlock(deptId, { admin })` for the `growth` and `strategy` departments (hooked in `engine/run.mjs` next to `memBlock`). Records the meeting's admin-stats as the week's snapshot. |
| Routes | `lib/growth/routes.mjs` | `/api/growth/*` (one dispatch line in `engine/server.mjs`). Local-only; writes need a same-origin Origin. |
| UI | `lib/ui/growth-client.js` | The Growth tab: This week · Plan to 1,000 · Calendar · Ad designer · Brand · Positioning · Creators · Paid plan. Styles in `lib/ui/theme.css` under `/* ---- Growth Studio ---- */`. |

Runtime files live in `<SEEN_HOME>/data/growth/` (gitignored): `brand.json`, `plan.json`, `actuals.json`,
`calendar.json`, `copy.json`, `daily.json`, `library.json` + `library/*.png`, `data-cache.json`. The brain
holds pointers (`growth:brand`, `growth:plan`, `growth:copy`) — supersede-never-overwrite like every fact.

## Routes

```
GET  /api/growth/overview                  this week: plan check, today's 1% item, streak, the week's calendar
GET  /api/growth/brand · POST {patch,note}  the kit; a save = new version + brain pointer
GET  /api/growth/positioning · /rules       competitor map + category · the playbook rules
GET  /api/growth/plan · POST {start,weeks}  the plan vs REAL numbers (rebuild resets the baseline)
GET  /api/growth/calendar?week=YYYY-MM-DD   a week (Mon–Sun, PT) · ?all=1 every item
POST /api/growth/calendar/generate {from,weeks}
POST /api/growth/calendar/<id>/status {status} · /<id>/results {impressions,views,sessions,upvotes,comments,shares,signups,reports,notes}
GET  /api/growth/copy/<id> · POST /<id>/draft [{format}] · POST /<id>/approve {variant}
GET  /api/growth/daily · POST {status: done|skipped|open, note, day}
GET  /api/growth/assets?week= · /data[?refresh=1] · /ads · /templates[/<id>] · /meeting?dept=growth|strategy
GET  /api/growth/library · POST {png,name,template,size,itemId,source} · GET /api/growth/library/<file>.png
GET  /api/growth/fonts/<Syne|InstrumentSans|DMMono-Medium>.woff2
```

## Assistant verbs (`node scripts/act.mjs …`)

`growth` · `daily [done|skip [note…]]` · `calendar [YYYY-MM-DD | generate [weeks]]` · `draft <item id>` ·
`approve-copy <item id> <0-2>` · `brand` · `positioning` · `ad [<item id> | <template>]`. Skill: `skills/growth-week.md`.

## Vendored assets and licences

| Asset | Licence | Source |
|---|---|---|
| Syne (`lib/growth/assets/fonts/Syne.woff2`) | SIL Open Font License 1.1 (`OFL-Syne.txt`) | The Syne Project Authors (gitlab.com/bonjour-monde/fonderie/syne-typeface); the family seenjobs.io loads from Google Fonts |
| Instrument Sans (`InstrumentSans.woff2`) | SIL OFL 1.1 (`OFL-InstrumentSans.txt`) | The Instrument Sans Project Authors (github.com/Instrument/instrument-sans); Google Fonts family |
| DM Mono Medium (`DMMono-Medium.woff2`) | SIL OFL 1.1 (`OFL-DMMono.txt`) | The DM Mono Project Authors (github.com/googlefonts/dm-mono); Google Fonts family |
| Icon paths in `growth-design.js` (ghost, circle-check, search, arrow-right, clock, shield-check, message-circle-off, badge-check) | ISC (`lib/growth/assets/LICENSE-lucide.txt`, Lucide v0.460.0 — includes the Feather MIT notice) | npm `lucide-static@0.460.0` (registry.npmjs.org), copied as path data |

The three woff2 files were vendored by the session that started this work; this session verified they are
valid WOFF2 (`wOF2` signature) and render (Playwright), and kept the OFL texts beside them. The OFL allows
bundling with software; the fonts are not sold on their own.

## Sources the rules cite

Geoffrey A. Moore, *Crossing the Chasm* (1991) · Peter Thiel, *Zero to One* (2014) · Paul Graham, "Do Things
That Don't Scale" (2013) and "Startup = Growth" (2012) · Dave McClure, "Startup Metrics for Pirates" (2007) ·
Sean Ellis & Morgan Brown, *Hacking Growth* (2017) · Alistair Croll & Benjamin Yoskovitz, *Lean Analytics*
(2013) · Kevin Kelly, "1,000 True Fans" (2008) · Eric Ries, *The Lean Startup* (2011) · Google Search Central,
"Creating helpful, reliable, people-first content" · Gabriel Weinberg & Justin Mares, *Traction* (2015) · Jonah
Berger, *Contagious* (2013) · Byron Sharp, *How Brands Grow* (2010) · April Dunford, *Obviously Awesome* (2019) ·
Al Ries & Jack Trout, *Positioning* (1981) · James Clear, *Atomic Habits* (2018) · FTC Endorsement Guides (16 CFR
Part 255) and the FTC rule on consumer reviews and testimonials (16 CFR Part 465) · CAN-SPAM Act (2003) · Reddit's
Content Policy and each subreddit's posted rules · Seen's own playbook and owner decisions.

## Not verified live (as of 2026-10-21)

- Real admin-stats numbers flowing through the plan check (no admin credentials in the build sandbox — the
  "unknown" path and stubbed numbers were tested; the live leaderboard callouts were read from seenjobs.io).
- A model lane polishing drafts (no model keys in the sandbox; the template path and a stubbed rewrite were tested).
- Subreddit rules (each item says to read the sidebar the day you post), competitor details (marked unverified),
  ad-platform minimums and policies (check each ad manager before the first test).
- The brain pointer writes against the real Chronos vault (tested with a stub writer and a scratch vault).
