// GitHub connector — the exec team's read + control over the Seen repo. Dependency-free REST calls
// (api.github.com) with a token from config. READS run freely; WRITES (merge, comment, create issue,
// dispatch workflow) are gated — the engine parks them at the approval gate and only `execute*` runs
// on Brandon's yes.

import { config } from '../config.mjs';

const API = 'https://api.github.com';

function headers() {
  const token = config.githubToken();
  if (!token) return null;
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'seen-command',
  };
}

async function gh(path, { method = 'GET', body } = {}) {
  const h = headers();
  if (!h) throw new Error('GitHub not configured (set GITHUB_TOKEN)');
  let res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { ...h, 'content-type': 'application/json' } : h,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
  // Retry transient 503 errors on GET requests (GitHub may be temporarily overloaded)
  if (method === 'GET' && res.status === 503) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // simple exponential backoff
      await new Promise(r => setTimeout(r, 1000 * attempt));
      const retryRes = await fetch(`${API}${path}`, {
        method,
        headers: body ? { ...h, 'content-type': 'application/json' } : h,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (retryRes.ok) {
        res = retryRes;
        break;
      }
      if (attempt === maxAttempts) {
        // final failure after retries
        throw new Error(`GitHub ${method} ${path} → ${retryRes.status}: ${(await retryRes.text()).slice(0, 160)}`);
      }
    }
  } else {
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
}
  return res.status === 204 ? {} : res.json();
}

const repo = () => config.githubRepo();       // "begindtheseen/seen"
const branch = () => config.githubBranch();    // "next-migration"

// ---- READS ----------------------------------------------------------------
export async function openPRs() {
  const prs = await gh(`/repos/${repo()}/pulls?state=open&per_page=20`);
  return prs.map((p) => ({
    number: p.number, title: p.title, author: p.user?.login, draft: p.draft,
    base: p.base?.ref, head: p.head?.ref, headSha: p.head?.sha,
    url: p.html_url, updatedAt: p.updated_at,
  }));
}

export async function recentCommits(n = 8) {
  const commits = await gh(`/repos/${repo()}/commits?sha=${encodeURIComponent(branch())}&per_page=${n}`);
  return commits.map((c) => ({
    sha: c.sha, short: c.sha.slice(0, 7), message: (c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name, date: c.commit?.author?.date, url: c.html_url,
  }));
}

// CI / Actions status for a commit (defaults to head of the default branch).
// Commits on any repo's branch since a moment (the Home tab's "recent changes" for both repos).
export async function recentCommitsFor({ repo: targetRepo, branch: br, since = null, n = 15 } = {}) {
  const q = `sha=${encodeURIComponent(br)}&per_page=${n}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  const commits = await gh(`/repos/${targetRepo}/commits?${q}`);
  return commits.map((c) => ({
    sha: c.sha, short: c.sha.slice(0, 7), message: (c.commit?.message || '').split('\n')[0],
    author: c.commit?.author?.name, date: c.commit?.committer?.date || c.commit?.author?.date, url: c.html_url, repo: targetRepo,
  }));
}

export async function ciStatus(sha) {
  let ref = sha;
  if (!ref) { const c = await recentCommits(1); ref = c[0]?.sha; }
  if (!ref) return { state: 'unknown', runs: [] };
  const data = await gh(`/repos/${repo()}/commits/${ref}/check-runs`);
  const runs = (data.check_runs || []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  const anyFail = runs.some((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
  const anyRunning = runs.some((r) => r.status !== 'completed');
  const state = runs.length === 0 ? 'none' : anyFail ? 'failing' : anyRunning ? 'running' : 'passing';
  return { state, sha: ref.slice(0, 7), runs };
}

export async function openIssues() {
  const issues = await gh(`/repos/${repo()}/issues?state=open&per_page=20`);
  return issues.filter((i) => !i.pull_request).map((i) => ({
    number: i.number, title: i.title, author: i.user?.login, labels: (i.labels || []).map((l) => l.name), url: i.html_url,
  }));
}

// Open issues for any repo (the exec team's task tracker lives on the Seen Command repo). Newest first.
export async function issuesFor(targetRepo) {
  const R = targetRepo || repo();
  const issues = await gh(`/repos/${R}/issues?state=open&per_page=50&sort=created&direction=desc`);
  return issues.filter((i) => !i.pull_request).map((i) => ({
    number: i.number, title: i.title, author: i.user?.login, body: i.body || '',
    labels: (i.labels || []).map((l) => l.name), url: i.html_url, createdAt: i.created_at,
  }));
}

// One issue's FULL live state by DIRECT per-issue fetch — { number, title, body, state, labels },
// or null on ANY error (404/network/auth) so the caller can fail open or closed as it chooses. Unlike
// the LIST endpoints (issuesFor/openIssues), a per-issue GET is read-your-writes consistent: a
// just-filed issue reads correctly immediately, where the list can omit it for seconds. The Tasks-tab
// build handler reads THIS to resolve the task it was asked to build (the old issuesFor().find() 404'd
// a task created seconds earlier — live #104). Field mapping mirrors issuesFor, so downstream code
// (title/body/taskShape) is identical whether the issue came from the list or from here. (The issues
// endpoint returns PRs too — the caller keys on a known issue number, so it only fetches a real issue.)
export async function issueInfo(targetRepo, number) {
  try {
    const i = await gh(`/repos/${targetRepo || repo()}/issues/${number}`);
    return { number: i.number, title: i.title, body: i.body || '', state: i.state,
      labels: (i.labels || []).map((l) => l.name), url: i.html_url,
      createdAt: i.created_at || null, updatedAt: i.updated_at || null, closedAt: i.closed_at || null };
  } catch { return null; }
}

// One issue's live state — 'open' | 'closed', or null on ANY error (fail open). A thin projection of
// issueInfo (the same single direct GET), kept as its own primitive because the builder's closed-task
// guard reads ONLY the state word. read-your-writes consistent, unlike the LIST endpoints.
export async function issueStateFor(targetRepo, number) {
  const i = await issueInfo(targetRepo, number);
  return i ? (i.state === 'closed' ? 'closed' : 'open') : null;
}

// Recently CLOSED tasks (+ why) — the board meeting must not re-propose work that was finished OR
// honestly rejected ("Upgrade Chronos SDK" was closed as unfulfillable and re-filed hours later as
// a fresh hallucination). Newest-closed first.
export async function closedIssuesFor(targetRepo, limit = 30) {
  const R = targetRepo || repo();
  const issues = await gh(`/repos/${R}/issues?state=closed&per_page=${limit}&sort=updated&direction=desc`);
  return issues.filter((i) => !i.pull_request).map((i) => ({
    number: i.number, title: i.title, reason: i.state_reason || 'closed', closedAt: i.closed_at,
  }));
}

// One-call snapshot the Product/Platform depts reason over. PRs + commits are load-bearing, so an
// auth/repo failure there THROWS (surfaced as {error} by the registry) rather than masquerading as
// "0 PRs". Issues/CI are best-effort.
export async function snapshot() {
  const [prs, commits] = await Promise.all([openPRs(), recentCommits()]);
  const issues = await openIssues().catch(() => []);
  const ci = await ciStatus(commits[0]?.sha).catch(() => ({ state: 'unknown', runs: [] }));
  return { repo: repo(), branch: branch(), openPRs: prs, recentCommits: commits, ci, openIssues: issues };
}

// ---- GATED WRITES (only run on explicit approval) -------------------------
export async function executeMergePR(number, method = 'squash') {
  return gh(`/repos/${repo()}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } });
}
// Merge a PR on an arbitrary repo (the builder auto-merges SAFE fixes on the tool repo only —
// the product repo always waits for Brandon, since merging there deploys prod).
export async function executeMergePRIn({ repo: targetRepo, number, method = 'squash' } = {}) {
  return gh(`/repos/${targetRepo || repo()}/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: method } });
}
// Open PRs on an arbitrary repo (head, draft, mergeable are what self-update needs).
export async function openPRsFor(targetRepo) {
  const prs = await gh(`/repos/${targetRepo || repo()}/pulls?state=open&per_page=30`);
  return (prs || []).map((p) => ({ number: p.number, title: p.title, head: p.head?.ref, draft: !!p.draft, url: p.html_url }));
}
export async function executeCommentPR(number, body) {
  return gh(`/repos/${repo()}/issues/${number}/comments`, { method: 'POST', body: { body } });
}
// Comment on an issue/PR in an arbitrary repo (the builder links a tracked issue to the PR it opens).
export async function executeCommentIssueIn({ repo: targetRepo, number, body } = {}) {
  return gh(`/repos/${targetRepo || repo()}/issues/${number}/comments`, { method: 'POST', body: { body } });
}
// Close a task (issue) in an arbitrary repo — the "Command knows instantly" primitive: the moment a
// task's PR merges, the task is DONE and leaves the Tasks tab (which reads live open issues).
export async function executeCloseIssueIn({ repo: targetRepo, number, comment } = {}) {
  const R = targetRepo || repo();
  if (comment) { try { await gh(`/repos/${R}/issues/${number}/comments`, { method: 'POST', body: { body: comment } }); } catch { /* close anyway */ } }
  return gh(`/repos/${R}/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
}
// Close a PR the builder itself opened — the "withdraw my own broken change" primitive: when a
// product PR's Vercel preview build FAILS, the builder closes the PR it opened rather than leave a
// stamped DO-NOT-MERGE lingering as a happy "PR ready". Comment first (best-effort, on the shared
// issues endpoint — PRs are issues for comments), then PATCH /pulls/{n} to set the PR state closed
// (state_reason is issue-only, so it's omitted here).
export async function executeClosePRIn({ repo: targetRepo, number, comment } = {}) {
  const R = targetRepo || repo();
  if (comment) { try { await gh(`/repos/${R}/issues/${number}/comments`, { method: 'POST', body: { body: comment } }); } catch { /* close anyway */ } }
  return gh(`/repos/${R}/pulls/${number}`, { method: 'PATCH', body: { state: 'closed' } });
}
// One PR's live state — task-reconcile reads merged; the conflict sweep reads mergeable/head; the
// post-create status check (build-runner → derivePrStatus) reads mergeable + mergeableState to know if
// a freshly-opened PR conflicts / has failing checks / is clean. mergeable is true/false/null (null =
// GitHub is still computing — treat as "not conflicting yet"); mergeableState is GitHub's own summary
// word ('clean'|'dirty'|'unstable'|'blocked'|'behind'|'unknown'…), 'unknown' while it computes.
export async function prInfo({ repo: targetRepo, number } = {}) {
  const p = await gh(`/repos/${targetRepo || repo()}/pulls/${number}`);
  return { number: p.number, state: p.state, merged: !!p.merged_at, draft: !!p.draft,
    head: p.head?.ref, headSha: p.head?.sha, mergeable: p.mergeable, mergeableState: p.mergeable_state, url: p.html_url,
    mergeSha: p.merged_at ? (p.merge_commit_sha || null) : null }; // the commit that landed on the base — what must be RUNNING
}
// Check-runs for a commit in ANY repo (ciStatus above is pinned to the default repo). Same verdict words.
export async function checkRunsFor({ repo: targetRepo, sha } = {}) {
  if (!sha) return { state: 'unknown', runs: [] };
  const data = await gh(`/repos/${targetRepo || repo()}/commits/${sha}/check-runs`);
  const runs = (data.check_runs || []).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion }));
  const anyFail = runs.some((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion));
  const anyRunning = runs.some((r) => r.status !== 'completed');
  return { state: runs.length === 0 ? 'none' : anyFail ? 'failing' : anyRunning ? 'running' : 'passing', sha: String(sha).slice(0, 7), runs };
}
// The files a PR touches — self-update's protected-paths guard reads this before auto-merging.
export async function prFiles({ repo: targetRepo, number } = {}) {
  const files = await gh(`/repos/${targetRepo || repo()}/pulls/${number}/files?per_page=100`);
  return (files || []).map((f) => f.filename);
}
export async function executeCreateIssue(title, body, labels = []) {
  return gh(`/repos/${repo()}/issues`, { method: 'POST', body: { title, body, labels } });
}

// File a real, tracked issue on any repo the token can push to (defaults to the product repo). Used
// as the exec team's "turn an approved action into a tracked task" primitive. Reversible (just close).
// IDEMPOTENT: filing the same work twice (even reworded) returns the EXISTING open task instead of
// creating a duplicate — the last line of defense against triplicate task spam.
export async function executeFileIssue({ repo: targetRepo, title, body = '', labels = [] } = {}) {
  const R = targetRepo || repo();
  if (!title) throw new Error('executeFileIssue needs a title');
  try {
    const { sameWork } = await import('../text.mjs');
    const open = await issuesFor(R);
    const dup = open.find((i) => sameWork(title, i.title));
    if (dup) return { number: dup.number, url: dup.url, repo: R, existing: true };
  } catch { /* similarity check is best-effort — filing proceeds */ }
  const issue = await gh(`/repos/${R}/issues`, { method: 'POST', body: { title, body, ...(labels.length ? { labels } : {}) } });
  return { number: issue.number, url: issue.html_url, repo: R };
}
export async function executeDispatchWorkflow(workflowFile, ref = branch(), inputs = {}) {
  return gh(`/repos/${repo()}/actions/workflows/${workflowFile}/dispatches`, { method: 'POST', body: { ref, inputs } });
}

// Open a PR with a single-file change — the exec team's "put an update in your GitHub, ready to
// merge" primitive. Creates the head branch off `base`, commits `content` to `path` (replace, or
// append to the existing file), and opens the PR. Works on any repo the token can push to (the
// product repo by default, or Seen Command's own repo for self-improvement). Dependency-free REST.
export async function executeOpenPR({ repo: targetRepo, base, title, body = '', head, path, content, mode = 'replace', message } = {}) {
  const R = targetRepo || repo();
  const baseBranch = base || (R === repo() ? branch() : config.commandBranch());
  if (!title || !head || !path || content == null) throw new Error('executeOpenPR needs { title, head, path, content }');

  // 1) SHA of the base branch tip.
  const baseRef = await gh(`/repos/${R}/git/ref/heads/${baseBranch}`);
  const baseSha = baseRef.object.sha;

  // 2) Create the head branch (tolerate "already exists" from a prior run).
  await gh(`/repos/${R}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${head}`, sha: baseSha } })
    .catch((e) => { if (!/already exists|Reference already/i.test(e.message)) throw e; });

  // 3) If the file already exists on the head branch, we need its blob SHA to update it.
  let existingSha; let existingText = '';
  try {
    const cur = await gh(`/repos/${R}/contents/${path}?ref=${encodeURIComponent(head)}`);
    existingSha = cur.sha;
    existingText = Buffer.from(cur.content || '', 'base64').toString('utf8');
  } catch { /* file doesn't exist yet — we'll create it */ }
  const finalText = mode === 'append' ? existingText + content : content;

  // 4) Commit the file to the head branch.
  await gh(`/repos/${R}/contents/${path}`, { method: 'PUT', body: {
    message: message || title, branch: head,
    content: Buffer.from(finalText, 'utf8').toString('base64'),
    ...(existingSha ? { sha: existingSha } : {}),
  } });

  // 5) Open the PR (or return the existing one if it's already open for this branch).
  try {
    const pr = await gh(`/repos/${R}/pulls`, { method: 'POST', body: { title, body, head, base: baseBranch } });
    return { number: pr.number, url: pr.html_url, repo: R, branch: head, created: true };
  } catch (e) {
    if (/A pull request already exists/i.test(e.message)) {
      const [existing] = await gh(`/repos/${R}/pulls?head=${R.split('/')[0]}:${encodeURIComponent(head)}&state=open`);
      if (existing) return { number: existing.number, url: existing.html_url, repo: R, branch: head, created: false };
    }
    throw e;
  }
}

// Open a PR for a branch that's already been pushed (the builder commits+pushes locally, then calls
// this). Returns the existing open PR if one already exists for the branch.
export async function executeOpenPRForBranch({ repo: targetRepo, head, base, title, body = '', draft = false } = {}) {
  const R = targetRepo || repo();
  const baseBranch = base || (R === repo() ? branch() : config.commandBranch());
  try {
    const pr = await gh(`/repos/${R}/pulls`, { method: 'POST', body: { title, body, head, base: baseBranch, ...(draft ? { draft: true } : {}) } });
    return { number: pr.number, url: pr.html_url, repo: R, created: true };
  } catch (e) {
    if (/A pull request already exists/i.test(e.message)) {
      const [ex] = await gh(`/repos/${R}/pulls?head=${R.split('/')[0]}:${encodeURIComponent(head)}&state=open`);
      if (ex) return { number: ex.number, url: ex.html_url, repo: R, created: false };
    }
    throw e;
  }
}

export const configured = () => !!config.githubToken();
