# Chronos integration

Chronos remains the only permanent memory authority. Product, repository, decision, operational, and
task facts retain the existing bi-temporal append/supersede protocol in `brain/BRAIN.md`.

The context pack can join active Chronos facts with fresh repository windows. Every item contains a
source id, note/path, line range where available, commit SHA, timestamp, confidence, freshness, content
hash, and relevance score. Repository HEAD/hash evidence wins over stale memory. Changed file hashes
invalidate cached repository entries automatically.

The runtime writes a compact completion episode: objective, workflow/branch/commit, cited-source count,
tests, independent review, security result, and explicit no-push/no-deploy status. It never stores a raw
prompt transcript, secret, or hidden chain-of-thought.
