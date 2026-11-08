---
name: data-health
description: Check and clean seenjobs.io's data — duplicate listings, stale listings, duplicate applicant reports, company names that differ only by Inc/LLC — with Seen's own safe, audited cleanup.
when: duplicates, duplicate, dupes, dedupe, stale, stale listings, clean up, cleanup, clean the data, data clean, data health, is the data clean, old listings, remove stale, merge companies
---
1. `node scripts/act.mjs data-health` — the four checks: how many duplicate listings, stale listings, duplicate reports and Inc/LLC company duplicates there are, with examples, the last cleanup and whether the daily automatic cleanup is on. Add `refresh` for a fresh check (the answer is cached for 2 minutes).
2. If Brandon only asked whether the data is clean, answer from step 1 in plain words (the `line` of each check) and stop. Never quote a number the answer did not contain; a check that failed says why — pass that on.
3. If he asked to clean, run the one that matches — it keeps going until Seen says it is done, then prints what it did:
   - "remove duplicates / dedupe listings" → `node scripts/act.mjs clean job_dupes`
   - "remove / clear stale listings" → `node scripts/act.mjs clean stale`
   - "duplicate reports" → `node scripts/act.mjs clean report_dupes` (copies are hidden, never deleted; it can be undone)
   - "merge duplicate companies" → `node scripts/act.mjs clean company_suffix_dupes` (only names that differ by Inc/LLC/Corp; each merge can be undone)
   - "clean up everything / clean the data" → `node scripts/act.mjs clean all`
4. Look-alike companies (`lookalikes` in step 1) are NEVER merged by you — they might be different companies. List them and tell Brandon to decide in Jobs → Data health (or Seen admin).
5. Report before → after: what was removed, what is left, and anything that failed with Seen's reason. Listings someone saved or applied to and employer posts are never removed — say so if he worries about losing something.
