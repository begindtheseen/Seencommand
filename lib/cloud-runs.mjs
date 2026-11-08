// The collector runs Seen does on its own servers (no Mac needed): Seen's hourly Vercel cron
// /api/cron-archive-reports logs each run in public.collector_runs, readable with the same Bearer token
// the Mac collectors use to send reports (SEEN_COMPANY_INTEL_INGEST_TOKEN).
// pollCloudRuns() turns every newly FINISHED run into one notification (deduped by run id).
import { config } from './config.mjs';
import { notify as defaultNotify } from './notifications.mjs';

const LABEL = { applicant_reports_cloud: 'Applicant reports (cloud, Reddit archive)' };

export async function fetchCloudRuns({ fetchImpl = fetch, env = process.env, base = config.seenBaseUrl() } = {}) {
  const token = env.SEEN_COMPANY_INTEL_INGEST_TOKEN;
  if (!token) return { ok: false, ready: false, runs: [], error: 'SEEN_COMPANY_INTEL_INGEST_TOKEN is not set' };
  try {
    const r = await fetchImpl(`${String(base).replace(/\/$/, '')}/api/cron-archive-reports?runs=1`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) return { ok: false, ready: false, runs: [], error: 'Seen has not deployed the cloud collector yet' };
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, ready: false, runs: [], error: b.error || `HTTP ${r.status}` };
    return { ok: true, ready: !!b.ready, runs: Array.isArray(b.runs) ? b.runs : [] };
  } catch (e) { return { ok: false, ready: false, runs: [], error: String(e.message || e).slice(0, 160) }; }
}

export function cloudRunNotice(run) {
  if (!run || run.status === 'running' || !run.finished_at) return null;
  const label = LABEL[run.pipeline] || run.pipeline;
  const companies = (run.summary?.companies || []).map((c) => `${c.company} ${c.new_reports ?? 0}`).join(', ');
  const level = run.status === 'complete' ? 'success' : run.status === 'partial' ? (run.new_reports > 0 ? 'success' : 'info') : 'error';
  const title = run.status === 'failed' ? `${label} failed` : `${label}: ${run.new_reports} new report${run.new_reports === 1 ? '' : 's'}`;
  const body = run.status === 'failed' ? (run.error || 'no reason given') : companies ? `New reports per company: ${companies}` : '';
  return { kind: 'cloud-run', level, title, body, tab: 'notifications', ref: String(run.id), key: `cloud:${run.id}`, at: run.finished_at };
}

// Quiet by design: a cloud run that found nothing is still recorded (key dedupes), so the tab is complete,
// but only runs that added reports or failed are worth a macOS banner — the shell decides by level.
export async function pollCloudRuns({ fetchRuns = fetchCloudRuns, notify = defaultNotify } = {}) {
  const r = await fetchRuns();
  let added = 0;
  for (const run of [...r.runs].reverse()) { const n = cloudRunNotice(run); if (n && notify(n)) added++; }
  return { ...r, added };
}
