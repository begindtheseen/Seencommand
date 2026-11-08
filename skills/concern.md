---
name: concern
description: When Brandon raises a problem or worry about Seen or Seen Command — find what is already known and already in motion before answering.
when: concern, worried, problem, broken, not working, issue with, bug, why is, something wrong, keeps failing
---
1. `node scripts/act.mjs recall <the key words of the concern>` — what the brain already knows, and any pending approval that matches.
2. `node scripts/act.mjs brief` — the last board meeting's constraint, every pending approval, running work.
3. If the concern is about collection or listings, also check `node scripts/act.mjs searches` and, for listings, `node scripts/act.mjs jobs …` with the filters it implies.
4. Answer in this order: what is actually happening (from what you read, with numbers), whether a fix is ALREADY waiting (name the approval title + id, and offer "say approve and I'll run it"), and the one next step you recommend.
5. If Brandon's concern states something durable he wants (not a question), save it: `node scripts/act.mjs note concern <topic> <his point in one sentence>` — recall first; skip if it is already there.
