# Brain MCP server — authenticated AI access to shared memory

Gives registered AI clients scoped access to the shared brain (the Chronos vault + Seen Command's
graph). Each source has a unique Chronos credential; the server derives the audited identity and
scopes from that credential instead of trusting a claimed name.

Dependency-free Node stdio server — no SDK, no `npm install`. It re-reads the vault on every call,
so recall is always current (including facts just written). All writes obey the vault rules
(supersede-never-overwrite; append-only ledger/timeline) via the one shared writer
(`brain/lib/memory-write.mjs`).

## Tools

| Tool | Use |
|---|---|
| `brain_overview()` | Snapshot of the whole brain — counts across both stores, bridges, span. Good first call. |
| `brain_search_facts({query?, as_of?, subject?, predicate?})` | Point-in-time recall. `as_of: "2026-07-01"` → what was true then; omit → now. |
| `brain_whats_changed({since})` | Facts recorded/invalidated since a date. Run at **session start**. |
| `brain_get_entity({name})` | A note's current + historical facts and its links/backlinks. |
| `brain_timeline({from?, to?})` | Dated session/board-meeting episodes, newest first. |
| `brain_contradictions()` | Overlapping-validity conflicts (hygiene). Run after writes. |
| **`brain_add_fact({note, subject, predicate, object, valid_from?, confidence?, source?})`** | Record a NEW typed fact. |
| **`brain_supersede_fact({note, id?/subject+predicate, object, date?, ...})`** | Change an existing fact the bi-temporal way (close old, append new). |
| **`brain_log_decision({title, body?, date?})`** | Append a locked decision to `decisions/log.md`. |
| **`brain_append_timeline({text, heading?, date?})`** | Append a session episode line to today's timeline note. |
| `brain_artifact_begin_upload`, `brain_artifact_upload_chunk`, `brain_artifact_finish_upload` | Upload a bounded, expiring, SHA-256-verified large-file artifact. Requires `artifact:write`. |
| `brain_artifact_list`, `brain_artifact_read_chunk` | List and receive the caller's active artifacts. Requires `artifact:read`. |
| `brain_github_open_file_pr` | Propose one allowlisted safe file update through a generated `codex/*` branch and draft PR. Requires `github:write`. |
| `brain_list_tickets({status?, repo?, kind?, limit?})` | Failure tickets Seen Command opened by itself (failed builds, collector runs, deploy drift, red tests, …). Default: every active one, ready-for-AI first. |
| `brain_get_ticket({id})` | One ticket in full: redacted error + log excerpt, run/build ids, links, every occurrence, plan, PR, claimant, allowed next statuses, and the who/when history. |
| **`brain_claim_ticket({id})`** | Take a ticket. Atomic — only one claimant; a claim with no activity for 6 h (`BRAIN_TICKET_CLAIM_TTL_HOURS`) expires and can be taken over. Requires `write`. |
| **`brain_update_ticket({id, status?, plan?, pr_url?, note?, duplicate_of?, helped?})`** | Plan (claimed → planned), PR url (→ pr_open), validated status moves, a note (anyone), duplicate, or a sharper "what would have helped". Only the claimant changes a claimed ticket. Requires `write`. |

### Tickets

A ticket is the note `tickets/<id>.md`; its fields are typed facts (subject `Ticket <id>`), so every
change supersedes and the closed facts are the history. Lifecycle:
`open → claimed → planned → in_progress → pr_open → merged`, or `resolved` (the failing thing later
succeeded), `wont_fix`, `duplicate`. One active ticket per failure fingerprint (kind + repo + the
failing thing); a repeat adds an occurrence. The claimant is always the caller's authenticated
principal — a `by` argument is ignored, and the names Seen Command writes under (`seen-command`,
`seen-command-builder`, `seen-command:owner`, `seen-command:assistant`) are refused here.
A ticket about Seen Command itself (`about: Seen Command itself`) always carries **what would have
helped** — the concrete ability or fix it lacked; seenjobs.io tickets list first. The owner merges the
PR from Seen Command → Tickets (or from the Board Room with `merge-pr` and his confirm phrase).

## Secure connection model

1. In Chronos → **Access**, create one client for the truthful source name and select only the scopes
   it needs. Prefer **install on this Mac**, which writes the secret directly to an owner-only file
   without exposing it to the renderer.
2. Configure that AI host at user/private scope—not project scope—with:

   - `CHRONOS_VAULT=/absolute/path/to/seen/memory`
   - `BRAIN_CLIENT=<registered-source>`
   - `BRAIN_CLIENT_CREDENTIAL_FILE=/absolute/path/to/.chronos/credentials/<source>.token`
   - command `node /absolute/path/to/command-os/brain/mcp/server.mjs`

3. Set `BRAIN_CLIENT` to the exact registered operational source. MCP `clientInfo.name` is only the
   host-software label (such as Claude Code); it is audited metadata and never selects a credential.

Never paste, print, log, commit, or place a credential in Brain. The project `.mcp.json` and
`brain/mcp/mcp.json` are intentionally empty so one AI cannot inherit another source's identity.
See `BRAIN_AI_CLIENT_PROTOCOL.txt` for the complete operating contract.

## No MCP configured? Call from the shell

A host that can run shell commands but has no `brain` MCP registered (for example a Codex session)
can make the same authenticated calls one at a time with `brain/mcp/call.mjs`. It starts this server,
authenticates with `~/.chronos/credentials/<BRAIN_CLIENT>.token` (or `BRAIN_CLIENT_CREDENTIAL_FILE`),
makes one tool call, prints the result, and exits — same scopes, same AI-traffic audit.

```bash
BRAIN_CLIENT=codex node brain/mcp/call.mjs tools
BRAIN_CLIENT=codex node brain/mcp/call.mjs brain_search_facts '{"query":"Seen"}'
echo '{"heading":"…","text":"…"}' | BRAIN_CLIENT=codex node brain/mcp/call.mjs brain_append_timeline -
```

Exit codes: 0 success, 1 tool error or denial, 2 bad usage. The credential is never an argument.

## Claude Code example

After installing a role-specific credential in Chronos, add the server to Claude's private local
configuration for that workspace. This example is the Brain-maintenance workspace:

```bash
claude mcp add --scope local brain \
  -e CHRONOS_VAULT=/absolute/path/to/seen/memory \
  -e BRAIN_CLIENT=claude-brain \
  -e BRAIN_CLIENT_CREDENTIAL_FILE=/absolute/path/to/.chronos/credentials/claude-brain.token \
  -- node /absolute/path/to/command-os/brain/mcp/server.mjs
```

A separate SeenJobs workspace should use its own local registration, source `claude-seenjobs`, and
`claude-seenjobs.token`. Do not use a user-wide generic Claude credential for both workspaces.
The owner has explicitly granted both of these separate Claude role principals all available scopes,
including `admin`; this elevation does not merge their identities or permit credential sharing.

For Claude Desktop, put the same three environment values and absolute server path in the private
desktop configuration:

```json
{
  "mcpServers": {
    "brain": {
      "command": "node",
      "args": ["/absolute/path/to/seen-command/brain/mcp/server.mjs"],
      "env": {
        "CHRONOS_VAULT": "/absolute/path/to/seen/memory",
        "BRAIN_CLIENT": "claude-brain",
        "BRAIN_CLIENT_CREDENTIAL_FILE": "/absolute/path/to/.chronos/credentials/claude-brain.token"
      }
    }
  }
}
```

## Verify by hand

Use a registered test client and its protected file; do not put the secret on the command line:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"Test MCP Host","version":"1"}}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brain_search_facts","arguments":{"subject":"Seen free tier","predicate":"daily_ai_credits","as_of":"2026-07-01"}}}' \
 | CHRONOS_VAULT=/absolute/path/to/seen/memory \
   BRAIN_CLIENT=test-client \
   BRAIN_CLIENT_CREDENTIAL_FILE=/absolute/path/to/.chronos/credentials/test-client.token \
   node /absolute/path/to/command-os/brain/mcp/server.mjs
```

The read succeeds only if the file holds the active credential owned by `test-client` and that client
has `read`. Missing, invalid, expired, revoked, scope-denied, and mismatched claims are denied and
remain visible in Chronos **AI traffic** with safe request context and the denial reason.

## Relationship to the seen repo's `chronos` server

Both read the same vault. `chronos` (in `seen`) is read-only; `brain` (here) adds the **write**
tools + the **unified** overview (Chronos vault + Seen Command graph). Use `brain` when an
authenticated client should update memory, not just query it. Writes are plain markdown edits,
reversible via git; the seen repo's optional `.graph` index can be refreshed with
`npm run memory:sync` there.
