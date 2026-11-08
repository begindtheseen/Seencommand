import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|secret|password|authorization|cookie|private[_-]?key|service[_-]?role|(?:(?:access|refresh|auth|id)[_-]?)?token)(?:$|[_-])|(?:apiKey|clientSecret|privateKey|serviceRole|accessToken|refreshToken|authToken|idToken)$/i;
const SECRET_TEXT = [
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}\b/gi,
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
];

export function redactSecrets(value, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return SECRET_TEXT.reduce((s, re) => s.replace(re, '[REDACTED]'), value);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactSecrets(v, k)]));
  return value;
}

export function safeRepoPath(repoRoot, candidate) {
  const abs = resolve(repoRoot, String(candidate || '.'));
  const rel = relative(repoRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path escapes assigned repository: ${candidate}`);
  if (/(^|\/)(?:\.env(?:\..*)?|\.git|node_modules|dist)(?:\/|$)/i.test(rel)) throw new Error(`protected path: ${candidate}`);
  return { absolute: abs, relative: rel || '.' };
}

export const FORBIDDEN_COMMAND = /(?:^|\s)(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot|kill|pkill|curl|wget|nc|ssh|scp|osascript)\b|(?:^|\s)git\s+(?:push|reset|clean|checkout|switch|merge|rebase)\b|(?:drop|truncate|delete\s+from|alter\s+table)\b/i;

export function validateCommand(command, { permission = 'READ_ONLY' } = {}) {
  const raw = String(command || '').trim();
  if (!raw) return { allowed: false, reason: 'empty command' };
  if (/[;&|`]|\$\(|\n|\r/.test(raw)) return { allowed: false, reason: 'shell composition is forbidden' };
  if (FORBIDDEN_COMMAND.test(raw)) return { allowed: false, reason: 'dangerous command is forbidden' };
  const readOnly = /^(?:git (?:status|diff|show|log|grep|rev-parse|ls-files)|rg|node --check|node --test|npm (?:test|run (?:build|lint|typecheck)))(?:\s|$)/;
  if (permission === 'READ_ONLY' && !readOnly.test(raw)) return { allowed: false, reason: 'command exceeds READ_ONLY scope' };
  return { allowed: true, reason: null };
}

export const stableHash = (value) => createHash('sha256').update(String(value)).digest('hex');
