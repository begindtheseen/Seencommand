# The Brain — Self-Model

*This is the brain describing itself: what a datapoint is, how the data fits together across the
systems, and the rules every session (you, Claude, or Seen Command) must follow to read and write it.
The point is that the brain can be **reasoned about and simplified** — a person or a session should be
able to open one datapoint and understand what it is, when it was created, what it changed, and how &
why it connects to everything else.*

---

## 1. One brain, three layers

There is **one** logical brain. It lives in three places, in this order of authority:

```
  YOU EDIT HERE                RUNTIME SOURCE OF TRUTH            REMOTE ACCESS
  ┌────────────────┐  push →   ┌──────────────────────┐          ┌───────────────────────┐
  │  Vault (files) │ ────────► │  Supabase mirror      │ ◄──────► │ <site>/api/brain      │
  │ ../seen/memory │ ◄──────── │  brain_notes          │  gateway │ (bearer token)        │
  │   *.md         │  syncDown │  brain_facts          │          │ read/write for cloud  │
  └────────────────┘           │  brain_timeline       │          │ sessions w/o local    │
                               └──────────────────────┘          └───────────────────────┘
```

- **Vault** — `../seen/memory/*.md`. Markdown notes with bi-temporal facts in frontmatter. This is the
  human-editable, git-versioned working copy that Chronos.app visualizes.
- **Supabase mirror** — `brain_notes` (verbatim note copy), `brain_facts` (queryable facts),
  `brain_timeline` (episodes). Written by `brain/lib/cloud.mjs` `pushBrain()` / the gateway.
- **Gateway** — `../seen/api/brain.js`, `https://<your-site>/api/brain` (set via env), bearer-gated. Lets a session
  with no local checkout read the brain and record facts.

## 2. The datapoint: a fact

Every fact is a triple with two time axes and provenance:

`subject —predicate→ object`

| field | what it answers |
|---|---|
| `subject` / `predicate` / `object` | the statement (e.g. *Seen search_api = v2*) |
| `valid_from` / `valid_to` | **real-world time** — when it was/is true (`valid_to: null` = still true) |
| `recorded` / `invalidated` | **knowledge time** — when we learned it / stopped believing it |
| `confidence` | high / medium / low |
| `source` | provenance pointer (a `[[note]]`, a `PR #`, a `path:line`) |
| `recorded_at` | full-timestamp creation time *(provenance, PR #124)* |
| `by` | who/what wrote it — a session, Seen Command, or Brandon *(PR #124)* |
| `change` | plain-language **what this changed and why** *(PR #124)* |
| `supersedes` | id of the fact this one replaced *(PR #124)* |

Defined in `brain/lib/chronos/memoryGraph.mjs` (`FACT_FIELDS`, parser) and written by
`brain/lib/memory-write.mjs` (`FACT_ORDER`, `addFact`, `supersedeFact`).

## 3. The key idea: a fact *is* a connection

`subject —predicate→ object` is a labeled edge between two entities. So the brain is already a graph:

- the **predicate** is *how* two things connect,
- `change` / `source` is *why*,
- `supersedes` draws the **history chain** ("v2 *replaced* v1 on 2026-07-02 because latency").

That is what makes the map a **navigable web**: click a node → see its facts (its edges) → travel to a
connected entity → see its facts → onward. Provenance is what lets every node and edge explain itself
in plain language when clicked — for a person *and* for a remote session asking the brain a question.

## 4. Bi-temporal rule: supersede, never overwrite

A value never gets edited in place. To change it: **close** the old fact (`valid_to` + `invalidated`
= today) and **append** a new one (`valid_from` = today, `supersedes` = old id). Nothing is deleted, so
the brain can answer both *"what was true on date X"* and *"what did we believe on date X."*

## 5. The gatekeeper: one writer

- **All writes go through the one shared writer** — `brain/lib/memory-write.mjs` (and its twin,
  `../seen/lib/server/writeFact.js`). Chronos is the only thing that mutates the brain; everyone else
  *proposes* writes through it. This is what makes the bi-temporal + serializer rules hold no matter who
  writes.
- **What earns a place in the brain:** durable, cross-session, non-derivable truth (a price, a policy, a
  schema fact, a decision). **What does not:** anything git already records (code structure, how a bug
  was fixed) or conversation ephemera.

## 6. The operational rule every session MUST know

**The cloud is the source of truth. Local vault edits do not stick on their own.** Each board meeting
runs `syncDown` (cloud→local) *first*, which overwrites local files with the cloud copy. So:

- To change the vault **durably**, change the **cloud** — `scripts/brain-repair.mjs --apply` for
  corruption heals (surgical), or `node brain/lib/cloud.mjs push` (push-only; the board-meeting push
  runs *after* syncDown, so it can't be used to introduce a local-only change).
- **Never `--force` pushBrain** — it clobbers notes that are newer in the cloud.
- Do vault surgery with the apps **stopped** (they sync live and will fight you).
- Credentials live in `command-os/.env` (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) — source them, never
  print them.

## 7. Serializer parity (do not break)

The writer and parser must be **exact inverses**: `parse(write(x)) === x` and a byte-level fixed point
(escapes can never grow). Two copies exist — `command-os/brain/lib/*` and `../seen/lib/server/*` — and
they must stay in sync; drift corrupts the shared brain for both. Guarded by the hostile-vector tests
(`brain/lib/memory-write.test.mjs`). History: the pre-#122 serializer compounded backslashes
(`n → 2n+1` per write cycle); fixed in #122 / seen `598cf4a`, and existing damage is healed by
`scripts/brain-repair.mjs` (proof-based — it refuses to guess).

## 8. File taxonomy

```
memory/
  knowledge/   durable reference facts, one note per subject
  decisions/   the locked "don't relitigate" ledger (log.md)
  timeline/    YYYY-MM-DD.md — append-only episodes ("what happened")
  people/      per-person notes
```

## 9. How the three systems relate

- **Seen Command** (`command-os` exec OS) — consumes the brain's truth to run its board meeting and act,
  and proposes writes back **through the writer**.
- **Chronos** (`brain/`) — the **only writer**, the **window** (the live memory-graph app), and the
  **MCP hub** the sessions connect to.
- **Claude** (any session) — reads/writes the same brain via the brain MCP (`brain/mcp/server.mjs`)
  locally, or the gateway (`<your-site>/api/brain`) remotely.

The connection between all three is the vault + its cloud mirror. Keep them in parity, write only
through the gatekeeper, and every datapoint stays self-explaining.
