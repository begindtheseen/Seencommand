// Failure normalization shared by both collector adapters: one vocabulary of failure categories so
// the dashboard, the run history, the Board Room skill and Chronos all describe a failure the same
// way. Classification is by the collector's OWN words (stderr / recorded lastErrors) — never guessed.

export const FAILURE_CATEGORIES = {
  opencli_missing: { label: 'OpenCLI not available', blocking: true, fix: 'Install OpenCLI on this Mac and make sure `opencli` is on PATH (Homebrew paths are searched).' },
  browser_bridge: { label: 'Chrome Browser Bridge disconnected', blocking: true, fix: 'Open Chrome with the OpenCLI Browser Bridge extension enabled and connected, then run again.' },
  human_verification: { label: 'Site asked for human verification', blocking: true, fix: 'Open the site in the connected Chrome profile and complete the check yourself (Seen Command never bypasses it), then run again.' },
  ingest_unauthorized: { label: 'Seen rejected the ingest token', blocking: true, fix: 'Make the local token match the Vercel Production secret (Settings → Aggregation).' },
  remote_storage: { label: 'Seen storage unavailable (Vercel Supabase env)', blocking: true, fix: 'The endpoint answered 503: SUPABASE_URL / SUPABASE_SERVICE_KEY are missing in the Vercel deployment. Fix them in Vercel and redeploy.' },
  not_deployed: { label: 'Endpoint not deployed', blocking: true, fix: 'Deploy the Seen commit that ships this endpoint.' },
  config: { label: 'Collector configuration rejected', blocking: true, fix: 'Correct the configuration shown in the error and run again.' },
  timeout: { label: 'Timed out', blocking: false, fix: 'Retry later; if it repeats, reduce the run size.' },
  rate_limited: { label: 'Rate limited by the source', blocking: false, fix: 'Wait before the next run and keep runs small.' },
  opencli_output: { label: 'Unexpected OpenCLI output', blocking: false, fix: 'Update OpenCLI; its adapter output did not match what the collector expects.' },
  network: { label: 'Network error', blocking: false, fix: 'Check this Mac’s connection and retry.' },
  other: { label: 'Other error', blocking: false, fix: 'Read the error text in the run detail.' },
};

export function classifyFailure(message) {
  const m = String(message || '');
  if (/ENOENT|opencli: (?:command )?not found|spawn opencli/i.test(m)) return 'opencli_missing';
  if (/cloudflare|captcha|verify (?:that )?you are (?:a )?human|human verification|challenge page|are you a robot/i.test(m)) return 'human_verification';
  if (/browser ?bridge|extension (?:is )?not (?:connected|installed)|not connected|disconnected|daemon|websocket|ECONNREFUSED/i.test(m)) return 'browser_bridge';
  if (/\((?:401|403)\)|unauthori[sz]ed|forbidden/i.test(m)) return 'ingest_unauthorized';
  if (/\(503\)|storage is unavailable|storage unavailable/i.test(m)) return 'remote_storage';
  if (/\(404\)|not found \(404\)/i.test(m)) return 'not_deployed';
  if (/must be (?:a |valid|an? )|needs a value|Set SEEN_|Set INDEED_|Set COMPANY_INTEL_/i.test(m)) return 'config';
  if (/\b429\b|too many requests|rate.?limit/i.test(m)) return 'rate_limited';
  if (/timed? ?out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(m)) return 'timeout';
  // Never match a bare "json": every OpenCLI command line carries `-f json`, so it says nothing.
  if (/non-JSON|no job detail|Unexpected token|invalid JSON|JSON\.parse/i.test(m)) return 'opencli_output';
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed|network/i.test(m)) return 'network';
  return 'other';
}

// Tally categories over a list of error strings → [{ category, label, count, example, fix, blocking }].
export function tallyFailures(messages = []) {
  const map = new Map();
  for (const msg of messages) {
    const c = classifyFailure(msg);
    const cur = map.get(c) || { category: c, count: 0, example: String(msg).slice(0, 200) };
    cur.count++; map.set(c, cur);
  }
  return [...map.values()].map((x) => ({ ...x, label: FAILURE_CATEGORIES[x.category].label, fix: FAILURE_CATEGORIES[x.category].fix, blocking: FAILURE_CATEGORIES[x.category].blocking }))
    .sort((a, b) => b.count - a.count);
}

// A collector prints its final metrics as one (pretty-printed) JSON object at the END of stdout, after
// any progress lines. Parse from the last line that opens a top-level object.
export function parseTrailingJson(stdout) {
  const text = String(stdout || '');
  const whole = text.trim();
  if (whole.startsWith('{')) { try { return JSON.parse(whole); } catch { /* progress lines precede it */ } }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '{' && !lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* keep looking further up */ }
  }
  return null;
}
