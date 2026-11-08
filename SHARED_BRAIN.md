# Shared Brain — the contract

Seen Command, Claude, and the brain Mac app all read/write **one** memory substrate: the **Chronos
vault** (bi-temporal facts as Markdown). This file is the handshake so every client stays compatible.

## One substrate, three clients
- **Claude (any session)** — connects to the vault as an MCP server: `memory/mcp/server.mjs` in the
  `seen` repo (`claude mcp add chronos -- node memory/mcp/server.mjs`). Reads via `memory_*` tools.
- **Seen Command** — writes what its exec team learns via `lib/brain.mjs`, into the same vault dir.
- **The brain Mac app** (separate build) — hosts / visualizes the vault.

## Where the vault lives
- Canonical: the `seen` repo's `memory/` directory (merged to `next-migration` as PR #164/#165).
- Seen Command points at it with `CHRONOS_VAULT=/path/to/seen/memory` (see `.env.example`).
- If unset, Seen Command falls back to a local vault at `command-os/data/brain/` (standalone mode).
- Point all three clients at the **same** directory to share one brain.

## Fact format (what everyone reads/writes)
A vault note is Markdown with a YAML frontmatter `facts:` list. Each fact is **bi-temporal** —
`valid_from`/`valid_to` = when it was true in the world; superseding a fact **closes the old
`valid_to` and appends a new fact** (never overwrite). Shape:

```yaml
---
title: Seen Command — Observations
facts:
  - id: seen-repo-open-prs-2026-07-07-3
    subject: Seen repo
    predicate: open_prs
    object: "3"
    valid_from: 2026-07-07
    valid_to: null          # null = currently true
    confidence: high
    source: "[[seen-command-observations]]"
    recorded: 2026-07-07
---
```

Required per fact: `id`, `subject`, `predicate`, `object`, `valid_from`. Parser/engine:
`seen` repo `lib/server/memoryGraph.js` (`buildIndex`, `searchFacts`, `factTrueAsOf`, …).

## Seen Command's write surface
- Owns one note: **`seen-command-observations.md`** in the vault. It never edits others' notes.
- Records live facts each board meeting (e.g. `Seen · mrr · $X`, `Seen repo · open_prs · 3`,
  `Seen · errors_today · 2`, `Supabase · health · up`), superseding prior values.
- `lib/brain.mjs`: `recordFacts([{subject,predicate,object,confidence?,source?}])`,
  `currentFacts()`, `readObservations()`.

## Rules so the two builds don't collide
1. **Append-only per note.** Each client owns its own note file(s); don't rewrite another's.
2. **Supersede, never overwrite** — preserve the timeline (close `valid_to`, append new).
3. **Same dir = same brain.** Coordinate the vault path via `CHRONOS_VAULT`.
4. **Reads are safe for anyone; writes stay within your own note.**

## Serializer parity — the ONE rule that keeps facts readable across repos
Two copies of the same serializer write this brain:

| | writer | parser |
|---|---|---|
| **this repo** | `brain/lib/memory-write.mjs` (`yamlScalar`) | `brain/lib/chronos/memoryGraph.mjs` (`parseScalar`) |
| **`seen` repo (canonical)** | `lib/server/writeFact.js` (`emitVal`) | `lib/server/memoryGraph.js` (`parseScalar`) |

They must be **exact inverses** — for every value the vault can hold:
`parse(write(x)) === x` and `write(parse(write(x))) === write(x)`.

This copy drifted once and it cost real data: it JSON-escaped double-quoted scalars while the parser
stripped the quotes *without* unescaping. Every value holding a `"` or `\` read back different from
what was written, which (a) defeated every writer's "unchanged → no-op" check, so the board meeting
re-superseded the same `Seen Command · current_focus` on every run, and (b) compounded backslashes
`n → 2n+1` per cycle against `seen`'s whole-block writer. Fixed to match `seen`'s `598cf4a`.

**If you change either file:** run `node --test brain/lib/memory-write.test.mjs` — it runs the same
hostile vector set as `seen`'s `lib/server/writeFact.test.mjs`. Keep the two vector sets in sync, and
port fixes to `seen`'s canonical pair rather than diverging here.

## Push conflicts — the cloud is not a dumb mirror
`brain/lib/cloud.mjs pushBrain()` mirrors the vault to Supabase (`npm run brain:sync`; the board
meeting runs one automatically at the end of every meeting). It used to upsert **everything,
unconditionally** — so a push from the Mac silently overwrote anything written online since this
machine last synced.

It is now guarded. Per note: no cloud row, or byte-identical content → pushed. A cloud row that
moved since this machine last reconciled **and** differs locally → **skipped and listed by name on
stderr**, and the facts derived from that note are withheld with it. A note this machine has never
synced counts as unreconciled, so a fresh machine can't clobber on its first push either.

```
[cloud] ⚠ PUSH GUARD — 1 note(s) changed in the cloud after this machine last synced …
    • knowledge/seen.md   (cloud updated_at 2026-07-20T10:00:00Z; last reconciled here: never)
```

**To resolve:** pull the cloud copy first (`npm run brain:restore`, or `syncDown`), reconcile, then
push again. **To overwrite the cloud with this machine's copy anyway:** `node brain/lib/cloud.mjs
push --force` — the only non-silent path, and the CLI exits `2` on a partial push so scripts notice.

The watermark that powers this is `data/cloud-sync.json` under `SEEN_HOME` — per-machine runtime
state, gitignored, deliberately **outside** the vault. `syncDown`/`pullBrain` write it; deleting it
is safe (the next push just treats every differing note as a conflict until you sync).

Known and unchanged: `syncDown` still overwrites LOCAL notes with the cloud copy — that is its job
(it is how Chronos stays live on the online brain), and it is the opposite direction from the
clobber this guard fixes.
