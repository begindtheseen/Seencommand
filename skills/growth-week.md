---
name: growth-week
description: Run Seen's growth week — where the plan to 1,000 users stands against real numbers, what to change, today's 1% item, this week's posts with trust-checked drafts, and the one decision Brandon has to make.
when: growth, marketing, plan to 1000, 1000 users, content calendar, what should i post, draft a post, ghost report post, brand, ads, ad design, influencers, creators, traction, 1% better, streak
---
1. `node scripts/act.mjs growth` — week N of the plan, target vs actual (users, paid, MRR, activation), overall status, what to change (each names its playbook rule), the next gates, today's 1% item, this week's calendar items. If `statsError` is set, say plainly that actuals are unknown — never estimate them.
2. If the calendar is empty or ends within two weeks: `node scripts/act.mjs calendar generate 6` (keeps everything approved, scheduled, posted or measured). Then `node scripts/act.mjs calendar` for this week's ids.
3. For the next item marked `owner: app` that is still `idea`: `node scripts/act.mjs draft <item id>` — show the three variants with their "why", and any trust flags. Never present a variant whose `trustOk` is false as ready. Approve only what Brandon picks: `node scripts/act.mjs approve-copy <item id> <0-2>`.
4. Today's 1%: read it from step 1. When Brandon says it is done: `node scripts/act.mjs daily done <what he did>` (or `daily skip`).
5. Paid: only if Brandon asks — `node scripts/act.mjs ad` shows readiness and the tranches; any spend goes through `node scripts/act.mjs simulate <the decision in words>` first. Never suggest spending while readiness says "not yet".
6. Report, tight: status line (week, target vs actual, ON-TRACK/BEHIND/UNKNOWN), the top change and its rule, the next gate with its date, the human-only tasks this week (owner: brandon), and ONE question for Brandon if a decision is needed. California dates only.
7. Rules you must not break while doing this: no invented numbers (only live callouts with their sample size), Brandon discloses he is the founder, Reddit is value first, money never changes a score.
