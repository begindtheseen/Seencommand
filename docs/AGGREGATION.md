# Aggregation Dashboard

Seen Command's control center for Seenjobs.io's two real-world data-collection pipelines. It runs
and monitors the **existing** Seen collectors. It does not re-implement them, and it keeps the two
pipelines separate.

| Pipeline | Collector (Seen repo) | Runs where | Writes to |
|---|---|---|---|
| **Company Intelligence** | `scripts/collect-reddit-company-intel.mjs` (`npm run ingest:reddit-intel`) | this Mac: OpenCLI Reddit + Chrome Browser Bridge | `GET /api/local-company-intel-targets`, `POST /api/ingest-local-company-intel` (`require_existing: true`) |
| **Indeed Jobs** | `scripts/ingest-indeed-opencli.mjs` (`npm run ingest:indeed`) | this Mac: OpenCLI Indeed + Chrome Browser Bridge | `POST /api/ingest-local-indeed` |

Both collectors drive the **same** Chrome Browser Bridge, and concurrent bridge sessions have not
been verified safe. So the two pipelines never run at the same time: a second run waits in a queue.

## Setup (one time, on the Mac)

1. **Seen checkout.** Keep a clone of `begindtheseen/Seen` on the branch that ships the collectors
   (`next-migration`, 2026-10-19 or later). The dashboard uses `SEEN_PRODUCT_REPO_DIR`, or `../seen`,
   or the path you set in **Aggregation → System Health**. The checkout is never bundled into the app.
2. **OpenCLI + Browser Bridge.** Install OpenCLI and its Chrome extension, then keep Chrome open with
   the extension connected. Complete any Indeed/Reddit human verification yourself in that Chrome
   profile. Seen Command never bypasses it.
3. **Tokens.** In **Settings → Aggregation (Seen ingest)**, paste:
   - `SEEN_LOCAL_INGEST_TOKEN`: the value of Vercel's `LOCAL_INDEED_INGEST_SECRET`
   - `SEEN_COMPANY_INTEL_INGEST_TOKEN`: the value of Vercel's `LOCAL_COMPANY_INTEL_INGEST_SECRET`

   They are stored in the runtime `.env` (owner-only) and never shown back. Optional https overrides:
   `SEEN_LOCAL_INGEST_URL` and `SEEN_COMPANY_INTEL_INGEST_URL` (for example, a preview deployment).
4. **Optional migration check.** If `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set, the dashboard
   does a read-only check that `20261019160000_company_intel_imports.sql` is applied. Without them
   that check shows **unknown**, not "missing".
5. **Production prerequisites (Vercel / Supabase, owner actions):** both secrets set in Vercel
   Production, the migration applied, and the Seen deployment shipping the three endpoints.

## Tabs

- **Overview.** *Quick start*: one tap for the everyday runs.
  - **Run this week's Indeed maintenance**: 2 searches from every Seen niche, Standard depth.
  - **Preview the top 10 major companies**: by open jobs; a preview sends nothing.
  - **Pull 200 employer job boards now**: see *Employer job boards* below.

  Then one card per pipeline, each in its own colour. A card shows the state (Ready / Running / Queued / Completed / Partially completed / Blocked / Failed), last run, last success, imports in the last 7 days, next scheduled run, problems, and what you need to do.
- **Indeed Jobs.** Three steps.
  1. **Pick what to refresh.** Tap sets to combine them:
     - *This week's maintenance*, which rotates weekly so 10 runs cover all 260 niche searches;
     - *What people searched on Seen* (real searches, 2 or more in 90 days);
     - *Thin coverage* (those that found under 10 results);
     - each of Seen's 13 niches (the same list Seen's refresh cron uses);
     - your saved sets.
  2. **Searches in this run.** Remove rows, add your own, and save the list as a set.
  3. **How deep.** Quick (10 per search), Standard (20), or Deep (25 + a 2nd page), with Advanced for exact numbers.

  One Start button counts the searches, plus a one-line summary of the last run with the full numbers underneath. Presets come from Seen's `GET /api/local-indeed-presets` (same token as the ingest).
- **Company Intelligence.** Three steps.
  1. **Pick companies.**
     - Quick picks: *Major companies* (top 25 by open jobs), *Need a grade* (open jobs but too few reports), *Least covered* (10+ open jobs, fewest reports), or *Let Seen choose*.
     - Or search and sort every company Seen knows, with open jobs, applicant reports, employee reviews and grade status.
     - Up to 100 per run. Unverified ATS-slug names are hidden by default and never auto-picked.
  2. **Preview only** or **Import into Seen**.
  3. **Depth**: 3, 5 or 10 threads per company.

  The list comes from `GET /api/local-company-intel-targets?catalog=1`, cached for 30 minutes because it reads every open listing. The choice reaches the collector as `COMPANY_INTEL_COMPANIES_JSON`. Imports still send `require_existing: true`, so a name Seen doesn't know is rejected, never created. A checkout without that option refuses a list and says to `git pull`.

  **Employer job boards** (card under the company tool). Seen pulls openings straight from company career sites (Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters) by itself every hour, keeping US and remote jobs only. The card pulls now:
  - **Pull boards for the selected companies** (up to 50, from the same picker), or
  - **Pull the 200 stalest boards**.

  It is one call to Seen's `POST /api/refresh-employer-boards` with the Indeed ingest token. Seen does the work server-side, so Chrome and OpenCLI aren't involved and it can run alongside a collector. One pull runs at a time. The result line shows boards answered, listings saved, and listings outside the US skipped, plus the chosen companies that have no registered board. Routes: `GET /api/aggregation/boards` and `POST /api/aggregation/boards/pull` (local Origin only; body `{companies}` or `{limit}`).
- **History.** Every run of both pipelines, filterable by pipeline, status, source, and date. Click a
  row for its full detail (configuration used, events, redacted output tails).
- **System Health.** The Seen checkout path, plus every readiness check with its fix.
- **Scheduling.** Independent daily/weekly schedules, **off by default**. They use the setup saved with **Save as the schedule's setup** and fire only while Seen Command is open and the Mac is awake. A slot missed while the app was closed is recorded as missed and **not replayed**.

## Guarantees (enforced in code and covered by tests)

- **No invented numbers.** A metric the collector doesn't report shows as "—" with a reason, never 0.
  This covers per-search yield, new-vs-updated rows, already-in-database duplicates, and unmatched
  company identities.
- **Partial is partial.** Any failed search or listing detail (after the CLI's own retries) makes a
  run *Partially completed*. When every search fails because of the bridge or a verification page,
  the run is *Blocked*, with the recovery step.
- **Identity.** Import mode runs only if the checked-out collector sends `require_existing: true`.
  The dashboard verifies this by reading the collector's source, so Seen rejects unknown companies
  instead of creating them. The manual `npm run ingest:company-intel` path is **not** exposed, because
  it can create companies.
- **Provenance.** Import mode also requires the collector source to show that it makes no model
  calls and that every item carries its source URL. Excerpts are redacted (emails, phones,
  profanity), never rewritten or summarized.
- **Safety.**
  - Runs use an explicit argv and a minimal env. No shell is used, and no route accepts a command,
    path, or env var.
  - Every API call must come from loopback with a localhost Host header. Every change must also
    carry the app's own Origin.
  - Secrets are redacted from everything stored.
- **Independence.** A Browser Bridge or Indeed failure never blocks Company Intelligence, and the
  reverse is also true.
- **No production changes without you.** Seen Command never applies migrations, never changes Vercel
  settings, and never creates or edits Seen records itself.

## Chronos and the Board Room

- **Run history** lives in `<SEEN_HOME>/data/aggregation/runs/*.json` (bounded, redacted). It is the
  primary record of every run.
- **Chronos** receives only conclusions, through the canonical writer (`lib/brain.mjs` →
  supersede-never-overwrite), under subject `seen:aggregation:<pipeline>`:
  - `health`: written when the health class changes
  - `persistent_blocker`: written when the same blocker stops 2 runs in a row, and superseded with
    "cleared" once a run succeeds
  - `schedule`: written when the owner enables or disables a schedule

  No job, excerpt, or URL is ever written to Chronos.
- **Board Room:** the owned `aggregation` skill answers questions like "how many jobs did Indeed
  import this week?" or "which collection pipeline is failing?" from run history only. Agents can
  read; the Board Room STARTS searches and presets (planned by engine/search-planner.mjs) but never changes schedules or credentials.

## Verification

- Unit tests, in `lib/aggregation/*.test.mjs` and `engine/aggregation-manager.test.mjs`.
- `engine/aggregation-contract.test.mjs` runs the **real** Seen scripts through the manager against
  a fake `opencli` and a fake local Seen. Point `SEEN_PRODUCT_REPO_DIR` at a checkout; the test is
  skipped without one.

## Not verified (needs the real Mac)

- The real OpenCLI `doctor` wording. Bridge detection only counts an explicit "connected"; anything
  else shows as *unverified*, and a run's own errors stay authoritative.
- A live Indeed or Reddit run against seenjobs.io.
- A signed `electron-builder --mac` build. The server and both collectors were verified under
  Electron 35's embedded Node (`ELECTRON_RUN_AS_NODE`).
