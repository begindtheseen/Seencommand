// Deterministic Board Room controls for editing pending proposals/approvals. A model never performs
// these writes: it parses to a concrete pending item, mutates the state copy, and the server persists
// it only after this function succeeds.

const lc = (v) => String(v || '').toLowerCase();
const words = (v) => new Set(lc(v).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
const replaceAllLiteral = (text, oldValue, newValue) => oldValue
  ? String(text || '').split(String(oldValue)).join(String(newValue)) : String(text || '');
const FIELD_ALIASES = new Map([
  ['title', 'title'], ['summary', 'summary'], ['scope', 'summary'], ['detail', 'summary'],
  ['details', 'summary'], ['request', 'summary'], ['repo', 'repo'], ['repository', 'repo'],
  ['target', 'targetPath'], ['target path', 'targetPath'], ['target file', 'targetPath'],
  ['path', 'targetPath'], ['file', 'targetPath'], ['target repo', 'repo'],
  ['target repository', 'repo'], ['acceptance', 'acceptanceCriteria'],
  ['criteria', 'acceptanceCriteria'], ['acceptance criteria', 'acceptanceCriteria'],
]);

function upsertPlainField(text, label, value) {
  const source = String(text || '').trim();
  const line = `${label}: ${value}`;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)${escaped}: [^\\n]*`, 'i');
  return pattern.test(source) ? source.replace(pattern, (m) => `${m.startsWith('\n') ? '\n' : ''}${line}`)
    : `${source}${source ? '\n' : ''}${line}`;
}

function upsertMarkdownField(text, label, value) {
  const source = String(text || '').trim();
  const line = `**${label}:** ${value}`;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\*\\*${escaped}:\\*\\* [^\\n]*`, 'i');
  return pattern.test(source) ? source.replace(pattern, (m) => `${m.startsWith('\n') ? '\n' : ''}${line}`)
    : `${source}${source ? '\n\n' : ''}${line}`;
}

function normalizeRepo(value) {
  const v = lc(value).replace(/[^a-z]/g, '');
  if (['tool', 'command', 'commandos', 'seencommand', 'app', 'platform'].includes(v)) return 'tool';
  if (['product', 'seen', 'seenjobs', 'site', 'website'].includes(v)) return 'product';
  throw new Error('target repo must be Seen Command or Seen product');
}

function normalizeTargetPath(value) {
  const v = String(value || '').trim().replace(/^\.\//, '');
  if (!v || v.startsWith('/') || v.startsWith('~') || v.includes('\0') || v.split(/[\\/]/).includes('..')) {
    throw new Error('target path must be a safe repo-relative path');
  }
  return v;
}

export function pendingApprovals(state) {
  return (state?.approvals || []).filter((a) => a.status === 'pending');
}

export function resolveApproval(state, target) {
  const pending = pendingApprovals(state);
  const raw = String(target || '').trim();
  if (!raw) return { approval: null, options: pending };
  const number = /^#?\s*(\d+)$/.exec(raw)?.[1];
  if (number) {
    const exact = pending.find((a) => a.id === raw || a.id?.endsWith(`-a${number}`));
    const indexed = pending[Number(number) - 1];
    return { approval: exact || indexed || null, options: pending };
  }
  const needle = words(raw);
  const scored = pending.map((a) => {
    const hay = lc(`${a.title} ${a.summary} ${a.action} ${a.dept} ${a.id}`);
    let score = 0; for (const w of needle) if (hay.includes(w)) score += 1;
    if (lc(a.title) === lc(raw)) score += 10;
    return { approval: a, score };
  }).sort((a, b) => b.score - a.score);
  if (!scored[0] || scored[0].score === 0 || (scored[1] && scored[0].score === scored[1].score)) return { approval: null, options: pending };
  return { approval: scored[0].approval, options: pending };
}

export function parseApprovalEdit(message, state) {
  const text = String(message || '').trim();
  const withField = /^\s*(?:edit|change|update|rewrite)\s+(?:the\s+)?(?:approval|proposal)\s+(.+?)\s+(title|summary|scope|details?|request|target\s+(?:repo(?:sitory)?|path|file)|repo(?:sitory)?|path|file|acceptance(?:\s+criteria)?|criteria)\s+(?:to|:)\s+([^]+)$/i.exec(text);
  const withoutField = /^\s*(?:edit|change|update|rewrite)\s+(?:the\s+)?(?:approval|proposal)\s+(.+?)\s+(?:to|:)\s+([^]+)$/i.exec(text);
  const m = withField || withoutField;
  if (!m) return null;
  const rawField = withField ? lc(m[2]).replace(/\s+/g, ' ') : 'summary';
  const field = FIELD_ALIASES.get(rawField) || 'summary';
  const value = String(m[withField ? 3 : 2] || '').trim();
  const resolved = resolveApproval(state, m[1].trim());
  return { type: 'edit-approval', field, value, target: m[1].trim(), ...resolved };
}

export function editApproval(state, approval, { field = 'summary', value } = {}) {
  if (!approval || approval.status !== 'pending') throw new Error('only a pending approval can be edited');
  if (!['title', 'summary', 'repo', 'targetPath', 'acceptanceCriteria'].includes(field)) throw new Error(`unsupported approval field: ${field}`);
  let clean = String(value || '').trim();
  if (!clean) throw new Error('the replacement text is empty');
  if (field === 'repo') clean = normalizeRepo(clean);
  if (field === 'targetPath') clean = normalizeTargetPath(clean);
  if (clean.length > (field === 'title' ? 180 : field === 'targetPath' ? 500 : 6000)) throw new Error(`${field} is too long`);
  const before = {
    title: approval.title || '', summary: approval.summary || '', repo: approval.build || '',
    targetPath: approval.targetPath || '', acceptanceCriteria: approval.acceptanceCriteria || '',
  };
  if (field === 'repo' && !approval.build) throw new Error('this approval does not launch an engineering build, so it has no target repo');
  approval[field] = clean;
  if (field === 'repo') { approval.build = clean; delete approval.repo; }
  approval.editedAt = new Date().toISOString();
  approval.editHistory = [...(approval.editHistory || []), { at: approval.editedAt, field, from: before[field], to: clean }].slice(-20);

  const arg = approval.exec?.args?.[0];
  if (arg && typeof arg === 'object') {
    if (field === 'title' && typeof arg.title === 'string') arg.title = replaceAllLiteral(arg.title, before.title, clean);
    if (field === 'title' || field === 'summary') arg.body = replaceAllLiteral(arg.body, before[field], clean);
    if (field === 'repo') arg.body = upsertMarkdownField(arg.body, 'Target repository', clean === 'tool' ? 'Seen Command' : 'Seen product');
    if (field === 'targetPath') arg.body = upsertMarkdownField(arg.body, 'Target path', clean);
    if (field === 'acceptanceCriteria') arg.body = upsertMarkdownField(arg.body, 'Acceptance criteria', clean);
  }
  if (typeof approval.buildTask === 'string' && (field === 'title' || field === 'summary')) approval.buildTask = replaceAllLiteral(approval.buildTask, before[field], clean);
  if (typeof approval.buildTask === 'string' && field === 'repo') approval.buildTask = upsertPlainField(approval.buildTask, 'Target repository', clean);
  if (typeof approval.buildTask === 'string' && field === 'targetPath') approval.buildTask = upsertPlainField(approval.buildTask, 'Target path', clean);
  if (typeof approval.buildTask === 'string' && field === 'acceptanceCriteria') approval.buildTask = upsertPlainField(approval.buildTask, 'Acceptance criteria', clean);

  const proposal = (state.proposals || []).find((p) => p.dept === approval.dept
    && (p.gatedAction === before.title || p.kind === approval.action));
  if (proposal) {
    if (field === 'title') proposal.gatedAction = clean;
    else if (field === 'summary') proposal.body = replaceAllLiteral(proposal.body, before.summary, clean);
    if (field === 'repo') proposal.body = upsertMarkdownField(proposal.body, 'Target repository', clean === 'tool' ? 'Seen Command' : 'Seen product');
    if (field === 'targetPath') proposal.body = upsertMarkdownField(proposal.body, 'Target path', clean);
    if (field === 'acceptanceCriteria') proposal.body = upsertMarkdownField(proposal.body, 'Acceptance criteria', clean);
    proposal.editedAt = approval.editedAt;
  }
  return approval;
}
