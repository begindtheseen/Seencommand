# Known limitations

- Legacy board reasoning in `lib/llm.mjs` and provider-native agentic loops predate the normalized
  gateway. New intelligence workflows use the gateway; migrating all legacy call sites is a separate
  compatibility hardening step and must preserve the 2,000+ existing tests.
- The context layer implements lexical/symbol retrieval and normalized-content caching. A pluggable
  semantic embedding adapter is not enabled because no embedding model/vector store is installed or
  benchmark-justified.
- Cancellation is checked/persisted at safe workflow boundaries. A currently executing synchronous
  test child is allowed to exit or timeout; it is not killed destructively.
- Durable workflow recovery restores the last safe checkpoint. General background dispatch/resume is
  not yet a daemon; the first slice is invoked by `npm run intelligence:slice`.
- Tool audit and workflow stores are local JSON/JSONL. They are atomic/append-only but not a distributed
  multi-host queue.
- Local model output quality is hardware/model dependent. Schema validation, gates, clean review, and
  bounded repair prevent false completion; they cannot guarantee every request is solvable locally.
- Eight real local-only slice attempts failed honestly and cleaned up, each exposing and pinning a
  distinct root cause. The ninth reached `COMPLETED` with a green gate, accepted independent review,
  green security scan, persisted PR package, and retained local proof branch. Local API/UI/package
  stress is complete; GitHub Actions on the unpublished draft branch remain unverified.
- The Supabase Management advisor diagnostic is externally unauthorized (401); product database health
  is separate and healthy. No production credential or database action was attempted.
- Local packages are ad-hoc/unsigned in this environment; ASAR remains disabled and the default Electron
  icon remains. Preserve the stable installed application when launching a packaged verification copy.
- The Codex in-app Browser currently blocks local HTTP URLs with `ERR_BLOCKED_BY_CLIENT`. Local UI
  verification therefore uses the repository-approved served-fetch plus script-parse fallback; the
  directly launched packaged Electron window and its live server/process tree were verified separately.
