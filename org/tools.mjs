// Tool registry — the real data sources and levers agents are wired to. This is how the exec team
// "knows where to steer": it reads Seen's live admin analytics, not vibes. Each tool declares its
// access (read / write) and whether writes are GATED (park at the approval gate — see policy.mjs).
//
// P1 defines the bindings + shapes; the live calls (admin token, Stripe, GitHub) drop in per tool.

export const TOOLS = {
  admin_stats: {
    id: 'admin_stats',
    name: 'Seen Admin (admin-stats)',
    reads: 'total/active users · revenue funnel (one-time sales, paying customers) · AI spend today+month · API errors · top searched & '
      + 'most-reported companies · suspicious/flagged users · applications tracked · outcome cards · '
      + 'signup→app→outcome conversion funnel',
    access: 'read + control',              // read the dashboard; write = admin actions (rescore, resolve, suppress)
    writeGated: true,                       // any admin mutation parks for yes/no
    endpoint: 'admin analytics endpoint (admin token, from env)',
  },
  analytics_doc: {
    id: 'analytics_doc',
    name: 'Analytics & scoring docs',
    reads: 'SCORING.md · KPI pack · growth-plan targets & kill-gates',
    access: 'read',
  },
  supabase: {
    id: 'supabase',
    name: 'Supabase (DB · auth · RLS)',
    reads: 'tables · schema · logs · advisors (RLS + perf lints)',
    access: 'read + migrate',                // read ungated; apply_migration / execute_sql = gated
    writeGated: true,
    endpoint: 'MCP: list_tables / get_advisors / get_logs (read) · apply_migration / execute_sql (write, gated)',
    note: 'Core datastore — watched as a dependency risk so it can never quietly become a ceiling.',
  },
  chronos: { id: 'chronos', name: 'Chronos shared memory', reads: 'facts · work queue · decisions', access: 'read + write' },
  github: { id: 'github', name: 'GitHub (Seen repo)', reads: 'PRs · CI · issues', access: 'read + write', writeGated: true },
  stripe: { id: 'stripe', name: 'Stripe', reads: 'one-time payments (30 days) · legacy subscriptions · refunds', access: 'read + write', writeGated: true },
  reddit: { id: 'reddit', name: 'Reddit', reads: 'r/recruitinghell threads', access: 'read + post', writeGated: true },
  email: { id: 'email', name: 'Email (Resend)', reads: 'outbound', access: 'send', writeGated: true },
  vercel: { id: 'vercel', name: 'Vercel', reads: 'deploys · runtime logs · health', access: 'read' },
  command_os: {
    id: 'command_os',
    name: 'Seen Command codebase (self)',
    reads: 'engine · memory · dashboard · run logs',
    access: 'read + write',                 // the tool improving itself; behavior changes gated
    writeGated: true,
    note: 'Self-maintenance — reversible fixes auto-apply, behavior changes park.',
  },
  instagram_compiler: {
    id: 'instagram_compiler',
    name: 'Instagram Knowledge Compiler (local)',
    reads: 'accessible Instagram video posts → transcripts · OCR · frames · evidence · canonical '
      + 'knowledge · reports, as a per-creator LOCAL research project (SQLite FTS + JSONL)',
    access: 'read + control',               // read the compiled library; control = start/cancel jobs
    writeGated: true,                        // raw-media cleanup + guidance→SeenJobs build park for owner OK
    endpoint: 'GET/POST /api/instagram/* — local venv worker; no Instagram password (reuses a local Instaloader session)',
    note: 'Private, local, noncommercial creator research. Advisory guidance ONLY — never product truth, '
      + 'never reproduces proprietary expression/branding/course material.',
  },
};

// Which tools each department is wired to. instagram_compiler here must match the departments that
// receive a creator-evidence block in board meetings (DEPT_TYPES in lib/instagram/insights.mjs).
export const DEPT_TOOLS = {
  strategy: ['admin_stats', 'analytics_doc', 'chronos', 'instagram_compiler'],
  data: ['admin_stats', 'analytics_doc', 'chronos'],
  growth: ['reddit', 'analytics_doc', 'chronos', 'instagram_compiler'],
  product: ['github', 'supabase', 'chronos', 'instagram_compiler'],
  reliability: ['vercel', 'supabase', 'admin_stats', 'chronos'],
  revenue: ['stripe', 'admin_stats', 'chronos', 'instagram_compiler'],
  platform: ['command_os', 'github', 'chronos'],
};

export const toolsFor = (deptId) => (DEPT_TOOLS[deptId] || []).map((t) => TOOLS[t]).filter(Boolean);
