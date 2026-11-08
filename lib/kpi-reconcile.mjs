// Command Center KPI tiles, reconciled against the brain.
//
// The tiles are BAKED into data/state.json by a board meeting. When no meeting can run — e.g.
// admin-stats has no credentials — the snapshot freezes, but the dashboard kept rendering its numbers
// with no date on them. Once the Command Center showed a "Total users" tile from a month-old
// snapshot while the brain already held a newer `users_total` fact.
// A stale number presented as current is worse than no number: nothing tells you not to trust it.
//
// The rule here needs no guessing and no alias invention beyond the four tiles the dashboard actually
// renders: a brain fact overrides a tile ONLY when the fact is newer than the snapshot it would
// replace. If the snapshot is newer, the snapshot stands (a board meeting saw fresher data than the
// brain). If neither is fresh, the tile still gets dated so it cannot masquerade as today's number.
//
// PURE: facts are passed in, so this is fully unit-testable and needs no vault access.

// Tile label → the brain predicate that holds the same quantity. Deliberately explicit: the snapshot
// and the brain name things differently (`users.total` vs `users_total`), and inferring that mapping
// automatically is how you end up displaying one metric under another metric's label.
const TILE_FACTS = {
  'Total users': { predicate: 'users_total', deltaPredicate: 'users_new_today', deltaSuffix: ' today' },
  'Revenue (30 days)': { predicate: 'revenue_30d', money: true },
  MRR: { predicate: 'mrr', money: true }, // tiles baked before the one-time model (2026-10-25)
  'Active jobs': { predicate: 'active_jobs' },
  'Errors today': { predicate: 'errors_today' },
};

const day = (v) => String(v || '').slice(0, 10);
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isNaN(n) ? null : n; };

// Brain facts store bare strings ("15844") while the tiles are thousands-formatted ("2,630"). Match the
// tile convention or an overridden number looks like a different kind of value than the one it replaced.
function tileValue(raw, money) {
  const s = String(raw ?? '').trim();
  const hadDollar = s.startsWith('$');
  const bare = hadDollar ? s.slice(1).trim() : s;
  const n = /^-?\d+(\.\d+)?$/.test(bare) ? Number(bare) : null;
  const shown = n === null ? bare : n.toLocaleString('en-US');
  return (money || hadDollar) ? `$${shown}` : shown;
}

// Newest OPEN fact per predicate. Open = valid_to null (bi-temporally still true).
function openByPredicate(facts) {
  const out = new Map();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || f.valid_to != null) continue;
    const p = String(f.predicate || '');
    const prev = out.get(p);
    if (!prev || day(f.valid_from) > day(prev.valid_from)) out.set(p, f);
  }
  return out;
}

export function reconcileKpis(kpis, facts, { snapshotISO, today, staleDays = 2 } = {}) {
  if (!Array.isArray(kpis) || !kpis.length) return Array.isArray(kpis) ? kpis : [];
  const byPred = openByPredicate(facts);
  const snapDay = day(snapshotISO);
  const todayDay = day(today);
  const ageDays = snapDay && todayDay
    ? Math.round((Date.parse(todayDay) - Date.parse(snapDay)) / 86400000) : null;
  const stale = ageDays != null && ageDays > staleDays;

  return kpis.map((k) => {
    const map = TILE_FACTS[k.label];
    const fact = map ? byPred.get(map.predicate) : null;
    // Override only when the brain is demonstrably fresher than the snapshot.
    if (fact && snapDay && day(fact.valid_from) > snapDay) {
      const value = tileValue(fact.object, map.money);
      const dFact = map.deltaPredicate ? byPred.get(map.deltaPredicate) : null;
      const dNum = dFact ? num(dFact.object) : null;
      const delta = dNum ? `+${dNum}${map.deltaSuffix || ''} · brain ${day(fact.valid_from)}`
        : `brain · ${day(fact.valid_from)}`;
      return { ...k, value, delta, source: 'brain' };
    }
    // No fresher fact. Never let an old snapshot read as current.
    if (stale) {
      return { ...k, delta: [k.delta, `as of ${snapDay}`].filter(Boolean).join(' · '), source: 'snapshot-stale' };
    }
    return k;
  });
}

// True when the snapshot is old enough that the dashboard should say so in the header too.
export function snapshotAgeDays(snapshotISO, today) {
  const a = day(snapshotISO); const b = day(today);
  if (!a || !b) return null;
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
