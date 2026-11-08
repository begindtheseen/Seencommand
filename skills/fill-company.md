---
name: fill-company
description: Make one company's Seen page complete — every open job from every source plus applicant reports — and say what it looks like after.
when: fill, cover, complete the page for, everything on, all jobs and reports for, build out
---
1. `node scripts/act.mjs jobs company=<company> limit=1` — how many listings Seen already has (read `total`).
2. `node scripts/act.mjs recall <company>` — what the brain knows (grade, reports, earlier searches).
3. `node scripts/act.mjs search <company> jobs and applicant reports` — one planned search: career site, job boards, Indeed, applicant reports and company intelligence together.
4. Tell Brandon what started (each method), the count before, and that you'll report the count after; when he asks later, run `searches` and `jobs company=<company> limit=1` again and give before → after.
