# brain/ — the shared brain's code (the Chronos desktop app is retired)

**Chronos.app was retired on 2026-10-21.** Everything it showed and did now lives in **Seen Command →
Brain** — one app, one window:

| Chronos had | Now in Seen Command |
|---|---|
| Graph (unified memory graph, search, type/brain filters, time slider + play, node detail) | Brain → **Graph** — `lib/ui/brain-graph.js` map + brain toggles + an as-of slider; a picked node offers *Ask the Board Room about this* |
| Brain activity: Latest changes · All changes · AI traffic (⌘L / ⌘⇧L / ⌘⌥L) | Brain → **Activity** (same three sections; the same shortcuts in Seen Command's **Brain** menu) |
| Overnight (the 4 AM agents' digests) | Brain → **Overnight** |
| Health (the Keeper's audit) | Brain → **Health**, plus *Where the brain lives* (pick the vault folder) |
| Access (issue / renew / rotate / revoke credentials, copy once) | Brain → **Access** (secrets shown once or installed on this Mac; never logged) |
| Background: vault + state.json watchers, the 60 s incremental cloud pull, Supabase env | `lib/brain-routes.mjs`, started by `engine/server.mjs` (env via `lib/config.mjs`) |
| ⌘1–⌘5 between views | the same, while the Brain tab is open |

`npm run brain:app` now only retires an installed copy: it quits Chronos and moves
`/Applications/Chronos.app` to the Trash (Finder → Put Back restores it); `npm run app:install` does the
same. The source below stays: it is the shared library the Brain tab, the board meeting and the brain
MCP server all use (`main.js` / `preload.js` / `renderer.html` are the old app's shell, kept for reference).

The graph unifies **two** memory stores:

1. **Seen Command** — `data/state.json` → `state.memoryGraph` (entities, values, work-queue threads,
   departments), regenerated every board meeting.
2. **Seen's Chronos vault** — the `seen` repo's `memory/` folder: bi-temporal typed facts
   (`valid_from`/`valid_to` + `recorded`/`invalidated`, "supersede never overwrite," provenance).

Where the same subject appears in both brains (e.g. *Seen*), a **bridge** link joins
them — unified, without hard-merging (each side keeps its provenance).

## The brain is read/write — Claude and Seen Command both rely on it and update it

`brain/` is the shared brain's read/write hub. **Read `BRAIN.md` for the
protocol.**

- **One shared writer** — `lib/memory-write.mjs`: `addFact`, `supersedeFact` (supersede-never-
  overwrite), `logDecision`, `appendTimeline`. Careful textual edits into the vault (the source of
  truth); reversible via git.
- **Authenticated AI clients** read *and update* the brain through the **`brain` MCP server** (`mcp/server.mjs`) —
  `brain_search_facts` (as-of), `brain_whats_changed`, `brain_add_fact`, `brain_supersede_fact`,
  `brain_log_decision`, … Wire each source in its own private/user MCP configuration with a unique
  Chronos credential; the shared `.mcp.json` stays empty (see `mcp/README.md`).
- **Seen Command** is connected via `../lib/brain.mjs`: the board meeting reads accumulated vault
  facts (not just static `SEED`) and writes each run + the current focus back — the graph grows on
  its own.
- Because Seen Command's server watches the vault, **a write by Claude or an agent re-renders the Brain
  tab live** — you watch the brain change.

## Where it reads from

Seen Command auto-locates both stores (see `lib/sources.mjs`):

| Store | Default | Override |
|---|---|---|
| Command state | `../data/state.json` (this repo) | `SEEN_COMMAND_STATE` |
| Chronos vault | `../../seen/memory` (sibling `seen` checkout) | `CHRONOS_VAULT` |

Resolution order: env var → auto-probe. Pick or change the vault folder in Seen Command → Brain →
Health → *Where the brain lives* (saved as `CHRONOS_VAULT` in Seen Command's `.env`; a folder picked in
the old Chronos app's first-run dialog is carried over automatically). With no vault the Brain tab runs
on the Command graph alone and says so.

## How it's built (reuse vs. new)

- **Reused:** the `seen` repo's pure, dependency-free bi-temporal engine — `memoryGraph.js`
  (`buildIndex`, `factTrueAsOf`, …) and `memoryGraphView.js` (`buildGraphView`) — vendored verbatim
  into `lib/chronos/` (source of truth stays in `seen`; re-copy on upstream change). Plus Seen
  Command's glassmorphism palette and Electron-shell pattern.
- **New:** `lib/unify.mjs` (merges both brains into one namespaced, bridged model), `lib/sources.mjs`
  (locates the stores), the Electron shell with **live file-watching over IPC** (`main.js` +
  `preload.js`), and the interactive temporal renderer with pan/zoom, search, filtering, and the
  click-to-inspect detail panel (`renderer.html`).

## Layout

```
brain/
  main.js            Electron shell: window + Dock, fs.watch on both stores, pushes graph over IPC
  preload.js         contextBridge — read-only graph API to the sandboxed renderer
  renderer.html      the unified temporal graph UI (canvas + glass panels), self-contained
  BRAIN.md           the shared-brain protocol (read/write loop for Claude + agents)
  mcp/
    server.mjs       authenticated, scoped AI read/write tools over the brain
    mcp.json         intentionally empty; credentials belong in per-source private config
    README.md        MCP tool table + wiring + verify-by-hand
  lib/
    sources.mjs      locate data/state.json + the Chronos vault (env-overridable)
    unify.mjs        build ONE {nodes, links, dateRange, counts} from both brains (+ bridges)
    vault.mjs        shared vault reader (walk → bi-temporal index)
    memory-write.mjs the ONE shared writer (addFact / supersedeFact / logDecision / appendTimeline)
    chronos/         vendored pure engine from the `seen` repo (do not hand-edit)
      memoryGraph.mjs
      memoryGraphView.mjs

../lib/brain.mjs     Seen Command's connector (board meeting reads/writes the brain)
```
