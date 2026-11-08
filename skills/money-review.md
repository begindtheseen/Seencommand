---
name: money-review
description: Answer money and scale questions about seenjobs.io from live numbers — how we are doing, whether we can afford something (run a simulation first), and what breaks first as we grow.
when: how are we doing financially, how's the money, revenue, mrr, profit, burn, runway, can we afford, should we spend, should we hire, what breaks first, scale, as we grow, costs, unit economics, allocate, allocation
---
1. `node scripts/act.mjs money` — the live picture. Quote MRR, paying users, month revenue, known costs, net and runway with their `trace` (where each number came from). Say plainly what is `unavailable` or "not enough data"; never fill a gap with a guess.
2. `node scripts/act.mjs allocate` — this month's split by stage (Profit First: profit and owner pay first). If `check.state` is `short`, say how much Operating is short and that costs must fit before anything else.
3. `node scripts/act.mjs units` — LTV only with measured churn (else say not enough data), break-even subscribers/users, and the scenario levers. Every scenario is a projection: name its assumptions.
4. "Can we afford X" or any spend, price, hire or plan change: run `node scripts/act.mjs simulate <the decision in words, with its $ amount and /mo if monthly>`. It gets live numbers automatically (users, measured growth, paid share, price, costs). Tell Brandon it is queued and that the verdict lands in the Board Room in a few minutes; when it is back, read `node scripts/act.mjs simulation <id>`.
5. "What breaks first as we grow": `node scripts/act.mjs scale` — lead with every ACT NOW item (reading, limit, ETA in California time, fix cost, action), then SOON, then readiness items marked overdue or due soon for the next user milestone.
6. A cost Brandon tells you: `node scripts/act.mjs cost-set "<name>" <monthly $> <note>`. A one-time amount is not a monthly cost — divide a yearly bill by 12 and say so.
7. Rules: money never changes a company's score (employer purchases buy reach or a badge, never a grade). seenjobs.io comes first. Locked pricing (the owner's current price list) is not relitigated — scenarios may model it, only Brandon changes it.
