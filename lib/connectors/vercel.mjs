// Vercel connector — the Reliability dept's read on deploys. Latest deployment + its state
// (READY / ERROR / BUILDING) for the Seen project. Read-only.

import { config } from '../config.mjs';

export async function latestDeployment() {
  const v = config.vercel();
  if (!v) return { configured: false };
  const params = new URLSearchParams({ limit: '1' });
  if (v.projectId) params.set('projectId', v.projectId);
  if (v.teamId) params.set('teamId', v.teamId);
  const res = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { authorization: `Bearer ${v.token}` },
  });
  if (!res.ok) return { configured: true, error: `Vercel ${res.status}` };
  const json = await res.json();
  const d = (json.deployments || [])[0];
  if (!d) return { configured: true, none: true };
  return {
    configured: true,
    state: d.state || d.readyState,      // READY | ERROR | BUILDING | QUEUED | CANCELED
    url: d.url, name: d.name,
    createdAt: d.created || d.createdAt,
    target: d.target, sha: d.meta?.githubCommitSha?.slice(0, 7),
  };
}

// The latest deployment for a git ref (optionally pinned to an exact commit sha) — the deploy
// ORACLE the PR verifier reads. Vercel builds a preview for EVERY branch with the same builder that
// deploys production, so a READY preview proves a change deploys and gives a URL to eyeball.
export async function deploymentForRef({ ref, sha = null, limit = 30 } = {}) {
  const v = config.vercel();
  if (!v) return { configured: false };
  const params = new URLSearchParams({ limit: String(limit) });
  if (v.projectId) params.set('projectId', v.projectId);
  if (v.teamId) params.set('teamId', v.teamId);
  const res = await fetch(`https://api.vercel.com/v6/deployments?${params}`, {
    headers: { authorization: `Bearer ${v.token}` },
  });
  if (!res.ok) return { configured: true, error: `Vercel ${res.status}` };
  const json = await res.json();
  const hit = (json.deployments || []).find((d) => {
    const m = d.meta || {};
    if (sha && m.githubCommitSha) return m.githubCommitSha === sha;
    return m.githubCommitRef === ref;
  });
  if (!hit) return { configured: true, none: true };
  return { configured: true, state: hit.state || hit.readyState, url: hit.url,
    sha: (hit.meta?.githubCommitSha || '').slice(0, 7), ref: hit.meta?.githubCommitRef, createdAt: hit.created || hit.createdAt };
}

export async function snapshot() { return { deployment: await latestDeployment().catch((e) => ({ error: e.message })) }; }
export const configured = () => !!config.vercel();
