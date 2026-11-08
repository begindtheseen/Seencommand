# Intelligence Runtime operations

Health and discovery:

```bash
npm run intelligence:hardware
npm run intelligence:models
npm run intelligence:verify
npm run intelligence:test
```

Run the local server on a disposable port:

```bash
SEEN_NO_OPEN=1 PORT=4599 node engine/server.mjs
curl http://127.0.0.1:4599/api/intelligence
curl http://127.0.0.1:4599/api/intelligence/workflows
```

Run a local-only slice:

```bash
npm run intelligence:slice -- --objective "<small low-risk engineering change>" --repo "$PWD"
```

The command creates an `exec/intelligence-*` branch/worktree, runs the canonical suite, independent
local review, security checks, and records a local PR package. It does not push, merge, install, or
deploy. Review workflow files under the active `SEEN_HOME/data/intelligence/workflows` and tool/cost
JSONL ledgers next to them. Operator UI cancellation uses the local same-origin API.

No workflow may be called complete unless state is `COMPLETED` and the `prPackage` shows green tests,
accepted review, accepted security, and truthful deployment booleans.

## Canonical test command

```sh
find . -name '*.test.mjs' \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.claude/*' \
  -not -path '*/dist/*' -not -path '*/data/*' -not -path '*/public/*' -print0 \
  | xargs -0 node --test
```

Every exclusion is load-bearing, and `*/…/*` patterns (not `./…/*`) are required so nested copies are
caught: session worktrees under `.claude/` and packaged app bundles under `dist/` each ship a full copy
of the source tree, and an over-broad `find` counts each copy (earlier inflated counts came from exactly
this duplicate discovery, not extra coverage). `xargs -0` matters too: a newline-joined `$(find …)`
argument can be mis-split and abort the run.
