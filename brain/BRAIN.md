# The Shared Brain — read this, rely on it, write to it

The "brain" is the shared, cross-session memory that **authenticated AI clients and Seen Command's
agents** read for context and write to when something changes. It is one substrate with one source
of truth and one write path — this file is the protocol that keeps every session using it.

## What the brain is

- **Source of truth:** the **Chronos vault** — the `seen` repo's `memory/` folder. Bi-temporal typed
  facts (`valid_from`/`valid_to` real-world time + `recorded`/`invalidated` knowledge time),
  provenance + confidence, wiki-linked notes, dated timeline episodes. Rule: **supersede, never
  overwrite.**
- **Operational layer:** Seen Command's board-meeting graph (`data/state.json`), regenerated each
  run — now *seeded from* the vault and *writing back to* it, so it accumulates.
- **The window:** Seen Command's **Brain tab** renders both, unified and live: Graph (with an as-of
  time slider), Activity (every write + every AI request), Overnight, Health (the Keeper's audit) and
  Access (credentials). Open it to *see* what the system knows and watch writes land. (It replaced the
  separate Chronos desktop app, retired 2026-10-21; `brain/` keeps the shared code and the MCP server.)

## Who reads/writes, and how

| Actor | Reads | Writes |
|---|---|---|
| **Authenticated AI client** (Codex, Claude, or another registered source) | `brain` MCP server (`brain/mcp/server.mjs`) | same MCP, subject to its scopes: `brain_add_fact`, `brain_supersede_fact`, `brain_log_decision`, `brain_append_timeline` |
| **Seen Command** (board meeting) | `lib/brain.mjs` → vault facts merged into the graph | `lib/brain.mjs` → records each run + current focus to the vault |
| **You (Brandon)** | Seen Command → Brain; the vault in Obsidian | edit the vault markdown directly |

All three go through the **one shared writer** (`brain/lib/memory-write.mjs`), so history and the
bi-temporal rules hold no matter who writes.

## Authenticated AI session loop (do this every session)

1. **Connect** the brain MCP once in the AI host's private/user configuration using its truthful
   registered `BRAIN_CLIENT` and its own owner-only `BRAIN_CLIENT_CREDENTIAL_FILE`. Never put a
   client credential in the project `.mcp.json`; that shared file is intentionally empty. See
   `brain/mcp/README.md` and `BRAIN_AI_CLIENT_PROTOCOL.txt`.
2. **At the start**, orient from the brain, not from memory:
   - `brain_overview()` — what the system knows right now.
   - `brain_whats_changed({ since: <last session date> })` — what moved since you were last here.
   - `brain_search_facts({ subject/query, as_of? })` for anything your task touches.
3. **During**, when you verify a durable truth (a price, a schema column, an endpoint, a status):
   - New truth → `brain_add_fact(...)`.
   - Changed truth → `brain_supersede_fact(...)` (never overwrite; the old value stays as history).
   - A locked call (pricing/policy/infra/architecture) → `brain_log_decision(...)`.
   - **The code wins over a stale fact** — when they disagree, fix the fact and note it.
4. **At the end**, `brain_append_timeline({ text: "<what shipped / verified / decided; Next: …>" })`.
   - **A handoff is a FACT, never an episode.** Anything addressed to another agent — a request, an
     instruction, a finding they must act on — goes in `brain_add_fact`. Timeline episodes are
     narrative: they do not surface in fact search or briefings, so an addressee reading facts will
     never see it, even though the write returned ok. `brain_append_timeline` warns when an entry
     looks addressed to someone, but the warning is a reminder, not a substitute for the fact.
5. Run `brain_contradictions()` after writes; fix any overlapping-validity conflicts.

This is why the brain is worth relying on: what you learn persists, and the next session (yours or a
teammate's) starts from it instead of re-deriving.

## How an AI picks up a ticket

Seen Command opens a **ticket** in the brain by itself whenever something fails — a build, a collector
run, a board meeting, a self-update, a PR's checks or preview build, post-merge proof, deploy drift, a red
base branch, schema drift, or the Board Room assistant failing a request — and closes it ("resolved by
success") when the same thing later succeeds. One active ticket per failure; a repeat adds an occurrence.
**seenjobs.io comes first:** a ticket about Seen Command itself exists only behind a real failure and always
says **what would have helped** (the ability or fix it lacked). Tickets are for any authenticated AI (Claude,
Codex):

1. **List** — `brain_list_tickets()` (active tickets; the ones the owner asked an AI to fix come first).
2. **Read** — `brain_get_ticket({ id })`: the evidence, every occurrence, the history, who holds it.
3. **Judge whether fixing it is a proper move.** A ticket marked *blocked on owner* (a credential, a
   quota, a migration only Brandon can apply) is not fixed by code — add a note saying what he must
   clear, and stop. A one-off that already passed, or a symptom of another ticket, is
   `brain_update_ticket({ id, status: "wont_fix" | "duplicate", note | duplicate_of })`.
4. **Claim** — `brain_claim_ticket({ id })`. Atomic: if someone else holds a live claim, leave a note
   instead. Your claim expires after 6 h without activity; every update you make refreshes it.
5. **Plan** — `brain_update_ticket({ id, plan })` (files, approach, how you will verify). Moves it to
   `planned`; `status: "in_progress"` when you start.
6. **Branch → PR** — never push to `main`/`next-migration`; open a PR, then
   `brain_update_ticket({ id, pr_url })` (moves it to `pr_open`).
7. **The owner merges** from Seen Command → Tickets (squash; only when every check is green and GitHub
   calls it mergeable), or in the Board Room (`merge-pr`, after he types the confirm phrase naming the
   head commit). The merge is recorded on the ticket and in the timeline. A PR merged on GitHub directly
   closes its ticket as merged on the next look.

Stored as `tickets/<id>.md` (subject `Ticket <id>`, one predicate per field), written only through
`memory-write.mjs`, so it syncs to the cloud brain like every note (Seen Command pushes shortly after a
ticket write). Never paste a secret into a plan or note — the text is redacted, but do not rely on it.

## Notes

- Writes are plain markdown edits to the vault — **reversible via git**, fully auditable.
- No rebuild needed after a write: the MCP server and Seen Command's Brain tab both re-derive live. The seen
  repo's optional `.graph` index can be refreshed with `npm run memory:sync` there.
- If the vault isn't found, reads return empty and writes are safe no-ops — Seen Command still runs;
  point `CHRONOS_VAULT` at `seen/memory` to reconnect.
