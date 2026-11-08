# Intelligence Runtime architecture

```text
Board Room / local API / CLI
            |
            v
Seen Command policy + durable workflow store
    |          |          |          |
 context   model gateway  tools    Chronos
 pack      + cost governor gateway  memory
    |          |          |          |
 repos     Ollama/opt-in  git/fs/    facts,
 + Brain   remote adapters tests     decisions
            |
   specialist task graph
            |
 isolated worktree coding worker
            |
 tests -> clean review -> security -> local PR package
```

The operator/API reads durable workflow files from the writable `SEEN_HOME/data/intelligence` directory.
It does not infer completion from model prose. The workflow record contains the objective, state,
current task, citations, model/runtime/cost, touched files, gate evidence, review findings, approvals,
failure, local diff package, and explicit deployment booleans.

The state machine is authoritative for intelligence workflows. Existing board meetings and builds
remain compatible execution surfaces of the same Seen Command control plane; they are not replaced by
a second agent framework.
