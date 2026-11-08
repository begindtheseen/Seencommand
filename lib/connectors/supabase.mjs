// Supabase connector — the Reliability dept's read on the core datastore. Safe reads only here:
// a reachability/health probe via PostgREST (service key), and — if a Management API token is set —
// security/perf advisors. Migrations and SQL writes are NEVER executed here; they're drafted and
// parked at the approval gate (anti-lock-in stance: the DB can't quietly become a ceiling).

import { config } from '../config.mjs';

// PostgREST reachability = "is the DB serving?" A 200/400 from the REST root means it's up.
export async function health() {
  const sb = config.supabase();
  if (!sb) return { configured: false, up: null, note: 'not configured' };
  try {
    const res = await fetch(`${sb.url}/rest/v1/`, { headers: { apikey: sb.key, authorization: `Bearer ${sb.key}` } });
    // PostgREST returns 200 (OpenAPI) when reachable; anything that responds = up.
    return { configured: true, up: res.status < 500, status: res.status };
  } catch (e) {
    return { configured: true, up: false, error: e.message };
  }
}

// Advisors (RLS / perf lints) via the Management API — optional; needs SUPABASE_ACCESS_TOKEN + ref.
//
// A bare "HTTP 401" is not actionable: it cannot tell Brandon whether the token is the wrong KIND of
// credential, whether a real Management token has been revoked/expired, or whether the token is fine
// and the project reference is wrong. So a failure here diagnoses itself — shape-check first, then a
// single token-only probe (`GET /v1/projects`, no project ref involved) that separates a dead token
// from a bad ref — and returns the exact remediation alongside the status.
const TOKENS_URL = 'https://supabase.com/dashboard/account/tokens';
const SETTINGS_HINT = 'Settings → Supabase → Management access token';
const clip = (v, n = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

// Management personal access tokens are `sbp_…`. The service-role key is a project JWT (`eyJ…`) and
// api.supabase.com will never accept it — pasting it into the wrong field is the classic 401 here.
function tokenKind(token) {
  if (/^sbp_/.test(token)) return 'management';
  if (/^eyJ/.test(token)) return 'service-role-jwt';
  return 'unknown';
}

async function tokenReaches(token, fetchFn) {
  try {
    const res = await fetchFn('https://api.supabase.com/v1/projects', { headers: { authorization: `Bearer ${token}` } });
    return res.ok;
  } catch { return null; } // network failure — can't conclude anything about the token
}

export async function advisors(type = 'security', { fetchFn = fetch } = {}) {
  const token = String(process.env.SUPABASE_ACCESS_TOKEN || '').trim();
  const ref = String(process.env.SUPABASE_PROJECT_REF || '').trim();
  if (!token || !ref) {
    return { available: false, reason: 'not-configured', note: 'set SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF for advisors',
      fix: `Add a Management access token (${TOKENS_URL}) and the project reference in ${SETTINGS_HINT}.` };
  }
  const kind = tokenKind(token);
  if (kind !== 'management') {
    return { available: false, reason: 'wrong-credential', tokenKind: kind,
      message: kind === 'service-role-jwt' ? 'SUPABASE_ACCESS_TOKEN holds a service-role JWT, not a Management token' : 'SUPABASE_ACCESS_TOKEN is not an sbp_ Management token',
      fix: `Paste a Management access token that starts with "sbp_" (create one at ${TOKENS_URL}) into ${SETTINGS_HINT} — the service-role key cannot authorize api.supabase.com.` };
  }

  let res;
  try {
    res = await fetchFn(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/advisors/${encodeURIComponent(type)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { available: false, reason: 'network', error: clip(e.message), fix: 'Check network access to api.supabase.com, then refresh diagnostics.' };
  }
  if (res.ok) {
    const json = await res.json();
    const lints = json.lints || json || [];
    return { available: true, type, count: Array.isArray(lints) ? lints.length : 0, lints };
  }

  const status = res.status;
  const message = clip(await res.text?.().catch(() => '') || '');
  // One extra read-only call, only on the failure path: does this token work at all?
  const tokenLives = status === 401 || status === 403 || status === 404 ? await tokenReaches(token, fetchFn) : null;
  if (tokenLives === false) {
    return { available: false, status, message, reason: 'token-rejected',
      fix: `The Management access token is revoked, expired, or mistyped — every api.supabase.com call is rejected. Create a new token at ${TOKENS_URL} and replace it in ${SETTINGS_HINT}.` };
  }
  if (tokenLives === true) {
    return { available: false, status, message, reason: status === 404 ? 'unknown-project' : 'project-forbidden',
      fix: `The Management access token works, but it cannot read project "${ref}" (HTTP ${status}). Correct SUPABASE_PROJECT_REF in Settings, or use a token from the organization that owns this project.` };
  }
  return { available: false, status, message, reason: 'http',
    fix: `The Management API returned HTTP ${status} for the advisor request. Retry, then verify the token and project reference in ${SETTINGS_HINT}.` };
}

export async function snapshot() {
  const h = await health();
  const adv = await advisors('security').catch((e) => ({ available: false, reason: 'error', error: clip(e.message) }));
  return { health: h, advisors: adv };
}

export const configured = () => !!config.supabase();
