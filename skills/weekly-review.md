---
name: weekly-review
description: A Monday-style review of the whole operation — what moved, what is stuck, and the three moves that matter this week.
when: weekly review, week in review, how did we do, status of everything, catch me up, what did i miss
---
1. `node scripts/act.mjs brief` — last meeting, pending approvals, running work.
2. `node scripts/act.mjs jobs since=7d limit=1` (read `total`) and `node scripts/act.mjs jobs since=today limit=1` — listings added this week and today.
3. `node scripts/act.mjs searches` — which searches and collectors finished, partly finished, or failed (and why).
4. `node scripts/act.mjs recall owner vision` — Brandon's stated priorities, so the review is judged against HIS goals.
5. Report, tight: Moved (numbers), Stuck (each with its reason and whether a fix is waiting — approval id), and THREE moves for this week ranked by impact on users and revenue. Offer to start any of them (a search, a meeting, an approval) in one word.
6. If the last board meeting is older than 3 days, offer to run one (`node scripts/act.mjs meeting`).
