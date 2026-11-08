# Security model

Permissions are ordered: `READ_ONLY`, `LOCAL_WRITE`, `BRANCH_WRITE`, `PREVIEW_DEPLOY`,
`PRODUCTION_WRITE`, `DESTRUCTIVE`. A worker receives the lowest required level. Tool registration
declares the minimum permission and side effects; invocation rejects escalation and requires an
approval record for production/destructive calls.

Repository paths are resolved and confined to the assigned worktree. `.env`, `.git`, dependency, and
build-output paths are protected. Commands are parsed as explicit executables/arguments; shell
composition, destructive commands, network utilities, git push/reset/clean/merge, and destructive SQL
are blocked. Shared checkouts and protected branches are never coding targets.

Secret-shaped keys and values are redacted before workflow, cost, tool, or model-cache persistence.
Credential APIs remain loopback/same-origin. Context indexing excludes secret-bearing paths and runtime
data. Audit logs record workflow/task/worker/tool, redacted arguments, start/end, result/error, side
effects, and approval record.

Production, destructive database, Supabase mutation, Vercel promotion, domains, billing, and secrets
always require a fresh explicit owner approval. The first slice registers no production-capable tool.
