// pr-merge — read a pull request's checks and mergeability, and squash-merge it ONLY when it is safe.
//
// The owner merges from Seen Command (the Tickets view), so this is the one place the rules live:
//   • only the two repos Seen Command builds (Seen and Seen Command itself);
//   • never into the product repo's `main` (the old production app — owner rule: never merge into it);
//   • the PR must be open, not a draft, mergeable, and GitHub must call it `clean` — which already means
//     every REQUIRED check and review passed. `unstable` (a non-required check red), `blocked`, `behind`,
//     `dirty` and the still-computing `unknown` all refuse;
//   • every check run on the head commit finished green (success / neutral / skipped), there is at
//     least one, and the commit's combined status is not failing or pending;
//   • the head commit is the one the owner looked at (`expectedHeadSha`), and the merge call itself is
//     pinned to it (`sha`), so a push between "looks good" and "merge" cannot sneak in.
// It never force-merges, never bypasses protection (there is no such call here), and never pushes to a
// branch. Dependency-free REST; `fetchImpl` and `token` are injectable so the tests run offline.

const API = 'https://api.github.com';
const GREEN = new Set(['success', 'neutral', 'skipped']);
const MERGEABLE_STATES = new Set(['clean', 'has_hooks']);

export function createGitHub({ token, fetchImpl = globalThis.fetch } = {}) {
  return async function gh(path, { method = 'GET', body } = {}) {
    if (!token) { const e = new Error('GitHub is not connected (set GITHUB_TOKEN in Settings)'); e.status = 503; throw e; }
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'seen-command', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text.slice(0, 200) }; }
    if (!res.ok) { const e = new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${String(json && json.message || '').slice(0, 200)}`); e.status = res.status; throw e; }
    return json;
  };
}

export function parsePrUrl(url) {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/.exec(String(url || ''));
  return m ? { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

const sameRepo = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
export function allowedRepo(repo, config) {
  return [config.commandRepo(), config.githubRepo()].some((r) => sameRepo(r, repo));
}
// Bases a merge must never land on.
export function forbiddenBase(repo, base, config) {
  return sameRepo(repo, config.githubRepo()) && String(base) === 'main';
}

// Fold GitHub's signals into one verdict with plain reasons.
export function mergeVerdict({ pr, runs = [], combined = null, repo, config }) {
  const why = [];
  if (!allowedRepo(repo, config)) why.push(`${repo} is not one of the repositories Seen Command manages`);
  if (pr.state !== 'open') why.push(pr.merged ? 'already merged' : 'the PR is closed');
  if (pr.draft) why.push('the PR is still a draft');
  if (forbiddenBase(repo, pr.base, config)) why.push(`the base is ${pr.base} — Seen's main is the old production app and is never merged into`);
  if (pr.mergeable === false || pr.mergeableState === 'dirty') why.push('it conflicts with its base branch');
  else if (pr.mergeable == null || pr.mergeableState === 'unknown') why.push('GitHub is still working out whether it can merge — check again in a moment');
  else if (pr.mergeableState === 'blocked') why.push('a required check or review is not satisfied');
  else if (pr.mergeableState === 'behind') why.push('the branch is behind its base — update it first');
  else if (pr.mergeableState === 'unstable') why.push('a check is failing');
  else if (!MERGEABLE_STATES.has(pr.mergeableState)) why.push(`GitHub reports it as ${pr.mergeableState}`);
  const pending = runs.filter((r) => r.status !== 'completed');
  const red = runs.filter((r) => r.status === 'completed' && !GREEN.has(r.conclusion));
  if (!runs.length && !(combined && combined.total > 0)) why.push('no checks have reported on this commit');
  if (red.length) why.push(`${red.length} check${red.length === 1 ? '' : 's'} failed: ${red.slice(0, 4).map((r) => r.name).join(', ')}`);
  if (pending.length) why.push(`${pending.length} check${pending.length === 1 ? ' is' : 's are'} still running`);
  if (combined && combined.total > 0 && combined.state !== 'success') why.push(`commit status is ${combined.state}`);
  const checks = red.length ? 'failing' : pending.length ? 'running' : runs.length || (combined && combined.total) ? 'passing' : 'none';
  return { canMerge: why.length === 0, reasons: [...new Set(why)], checks };
}

// Everything the Merge button needs, read live.
export async function prStatus(gh, { repo, number, config }) {
  const p = await gh(`/repos/${repo}/pulls/${number}`);
  const pr = {
    repo, number: p.number, title: p.title, url: p.html_url, state: p.state, merged: !!p.merged_at, draft: !!p.draft,
    base: p.base && p.base.ref, head: p.head && p.head.ref, headSha: p.head && p.head.sha,
    mergeable: p.mergeable, mergeableState: p.mergeable_state || 'unknown', author: p.user && p.user.login,
    mergedAt: p.merged_at || null, mergeSha: p.merged_at ? p.merge_commit_sha || null : null, updatedAt: p.updated_at || null,
  };
  let runs = []; let combined = null;
  if (pr.headSha) {
    const cr = await gh(`/repos/${repo}/commits/${pr.headSha}/check-runs?per_page=100`);
    runs = (cr.check_runs || []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url || r.details_url || null }));
    try {
      const st = await gh(`/repos/${repo}/commits/${pr.headSha}/status`);
      combined = { state: st.state, total: st.total_count || 0, statuses: (st.statuses || []).map((x) => ({ name: x.context, state: x.state, url: x.target_url || null })) };
    } catch { combined = null; }
  }
  return { pr, runs, combined, ...mergeVerdict({ pr, runs, combined, repo, config }) };
}

// Open PRs on both repos, newest first, with their basic state (the status is read per PR on demand).
export async function openPRs(gh, { config }) {
  const out = [];
  for (const repo of [config.githubRepo(), config.commandRepo()]) {
    try {
      const list = await gh(`/repos/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`);
      for (const p of list || []) out.push({ repo, number: p.number, title: p.title, url: p.html_url, draft: !!p.draft, base: p.base && p.base.ref, head: p.head && p.head.ref, author: p.user && p.user.login, updatedAt: p.updated_at });
    } catch (e) { out.push({ repo, error: e.message }); }
  }
  return out;
}

// Squash-merge when — and only when — the verdict says it is safe, re-read at the moment of merging.
export async function mergePR(gh, { repo, number, expectedHeadSha, config }) {
  const st = await prStatus(gh, { repo, number, config });
  if (!st.canMerge) return { ok: false, code: 409, error: `Not merging: ${st.reasons.join('; ')}`, status: st };
  if (!expectedHeadSha) return { ok: false, code: 400, error: 'Not merging: the head commit you reviewed is required', status: st };
  if (st.pr.headSha !== expectedHeadSha) return { ok: false, code: 409, error: 'Not merging: the PR changed after you looked at it — review the new commit first', status: st };
  try {
    const r = await gh(`/repos/${repo}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash', sha: st.pr.headSha } });
    return { ok: !!r.merged, merged: !!r.merged, sha: r.sha || null, message: r.message || null, status: st, ...(r.merged ? {} : { code: 409, error: r.message || 'GitHub did not merge it' }) };
  } catch (e) {
    return { ok: false, code: e.status && e.status < 500 ? 409 : 502, error: `GitHub refused the merge: ${e.message}`, status: st };
  }
}
