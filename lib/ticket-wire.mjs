// Turns failures into brain tickets for this process. Imported once, by lib/notify-wire.mjs, which only
// entry points load (the server, the build runner, the board meeting) — so tests and libraries never open
// tickets as a side effect. The mapping itself lives in lib/ticket-sources.mjs.
//
// Tickets are vault notes, so they reach the cloud brain the way every note does (brain/lib/cloud.mjs
// pushBrain — guarded, incremental, never overwriting a newer cloud copy). After a ticket write this
// process schedules ONE push a little later, so a burst of failures is one push, and an AI reading the
// cloud brain sees the ticket within a minute instead of at the next board meeting. A CLI that exits
// right away (deploy drift, base health) awaits `flushTicketsToCloud()` before exiting.
import { config } from './config.mjs';
import { brainVault } from './brain.mjs';
import { readBuild } from './builds.mjs';
import { createStore, redact } from './aggregation/store.mjs';
import { onActivity } from './activity.mjs';
import { setFailureTicketHooks } from './failure-loop.mjs';
import { createTicketSources } from './ticket-sources.mjs';

const PUSH_DELAY_MS = 20_000;
let pushTimer = null; let dirty = false;
async function pushNow() {
  pushTimer = null;
  if (!dirty) return null;
  dirty = false;
  try {
    const cloud = await import('../brain/lib/cloud.mjs');
    if (!cloud.cloudConfigured()) return null;
    const v = brainVault();
    return v ? await cloud.pushBrainSafe(v) : null;
  } catch (e) { process.stderr.write(`[tickets] cloud push skipped: ${e.message}\n`); return null; }
}
function schedulePush() {
  dirty = true;
  if (pushTimer) return;
  pushTimer = setTimeout(pushNow, PUSH_DELAY_MS);
  pushTimer.unref?.();
}
export async function flushTicketsToCloud() {
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  return pushNow();
}

let store = null;
export const ticketSources = createTicketSources({
  vault: brainVault,
  config,
  readBuild: (id) => { try { return readBuild(id); } catch { return null; } },
  readRun: (id) => { try { store ||= createStore(); return store.readRun(id); } catch { return null; } },
  redact: (s) => redact(s),
  onWrite: schedulePush,
});
setFailureTicketHooks({ onFailure: ticketSources.onFailure, onResolve: ticketSources.onResolve });
onActivity(ticketSources.onActivity);
