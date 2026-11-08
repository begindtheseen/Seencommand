# Recovery

Workflow files are atomically replaced after every transition. At server start,
`WorkflowStore.recoverInterrupted()` moves nonterminal interrupted work back to `CONTEXT_READY` or
`QUEUED` from the last safe checkpoint; it never restarts from the original request blindly.

After a crash:

```bash
git status --short --branch
npm run intelligence:verify
find data/intelligence/workflows -name '*.json' -maxdepth 1 -print
git worktree list
git worktree prune
```

Do not delete a worktree or branch until its workflow record and diff are inspected. A failed slice
normally removes its own worktree/branch. A successful slice keeps the local `exec/intelligence-*`
branch as PR-ready evidence and removes only the temporary checkout.

To resume development, return to the implementation branch, preserve pre-existing runtime files, run
the focused and canonical suites, then inspect explicit diffs. Never use `git reset --hard`, broad
`git clean`, or `git add -A` in a dirty shared checkout.
