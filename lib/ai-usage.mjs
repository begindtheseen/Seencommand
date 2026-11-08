import { appendFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.mjs';

export const usagePath = () => join(dataDir(), 'ai-usage.jsonl');

export function recordAIUsage(event, { path = usagePath() } = {}) {
  const row = { at: event.at || new Date().toISOString(), provider: String(event.provider || 'unknown').slice(0, 80), model: String(event.model || 'provider default').slice(0, 160), surface: String(event.surface || 'unknown').slice(0, 80), requests: Math.max(1, Number(event.requests || 1)), inputTokens: Math.max(0, Number(event.inputTokens || 0)), outputTokens: Math.max(0, Number(event.outputTokens || 0)), costUsd: Math.max(0, Number(event.costUsd || 0)) };
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return row;
}

export function usageReport({ path = usagePath(), now = new Date() } = {}) {
  let rows = [];
  try { rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { /* no observations yet */ }
  const cutoff = +now - 30 * 864e5;
  rows = rows.filter((r) => Number.isFinite(+new Date(r.at)) && +new Date(r.at) >= cutoff);
  const groups = new Map();
  for (const r of rows) { const key = `${r.provider}\0${r.model}`; const g = groups.get(key) || { provider: r.provider, model: r.model, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastUsedAt: null }; g.requests += Number(r.requests || 1); g.inputTokens += Number(r.inputTokens || 0); g.outputTokens += Number(r.outputTokens || 0); g.costUsd += Number(r.costUsd || 0); if (!g.lastUsedAt || r.at > g.lastUsedAt) g.lastUsedAt = r.at; groups.set(key, g); }
  const total = rows.reduce((a, r) => ({ requests: a.requests + Number(r.requests || 1), costUsd: a.costUsd + Number(r.costUsd || 0), tokens: a.tokens + Number(r.inputTokens || 0) + Number(r.outputTokens || 0) }), { requests: 0, costUsd: 0, tokens: 0 });
  const daily = Array.from({ length: 30 }, (_, i) => ({ date: new Date(+now - (29 - i) * 864e5).toISOString().slice(0, 10), costUsd: 0, requests: 0 }));
  for (const r of rows) { const d = daily.find((x) => x.date === String(r.at).slice(0, 10)); if (d) { d.costUsd += Number(r.costUsd || 0); d.requests += Number(r.requests || 1); } }
  return { generatedAt: now.toISOString(), periodDays: 30, total, models: [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests), daily, disclaimer: 'Observed by Seen Command only. Remaining subscription credits are shown only when a provider exposes a supported balance API; unknown is never estimated.' };
}
