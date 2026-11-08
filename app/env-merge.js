// .env merge-on-launch — keeps the packaged app's runtime .env (SEEN_HOME/.env, the user's source
// of truth for VALUES) in sync with the bundled .env (Contents/Resources/.env, the source of truth
// for which KEYS exist). Seed-once copying meant new config keys shipped in an app update never
// reached the runtime file (bit us on 2026-07-09 with SEEN_PRODUCT_REPO_DIR); this closes that gap
// without ever touching a value the user set.
//
// Rules:
//   - Append-only: the runtime file's existing lines are preserved byte-for-byte; missing keys are
//     appended verbatim (the bundle's raw line) under one marker comment.
//   - A key counts as present in the runtime file if it is set (KEY=...) OR deliberately commented
//     out (# KEY=...) — the merge never resurrects a key the user disabled.
//   - Key parsing mirrors lib/config.mjs loadEnvFile(): split on the first '=', trim, skip blanks
//     and '#' comments; first occurrence of a key wins.
//
// CommonJS on purpose: app/main.js is CJS (Electron main); ESM tests import the named exports.
'use strict';

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

// Non-comment KEY=VALUE entries, in order, first occurrence per key (matches config.mjs precedence).
// Each entry keeps the raw line so a merge appends exactly what the bundle ships.
function parseEnvEntries(text) {
  const entries = [];
  const seen = new Set();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || !KEY_RE.test(key) || seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, raw: line });
  }
  return entries;
}

// Keys the runtime file already owns: set lines plus commented-out lines like "# KEY=..." (a key
// the user disabled on purpose — adding it back would silently re-enable it).
function ownedKeys(text) {
  const keys = new Set(parseEnvEntries(text).map((e) => e.key));
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^#+\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(raw.trim());
    if (m) keys.add(m[1]);
  }
  return keys;
}

// The merge: returns { text, added }. `text` is the runtime content with any bundle-only keys
// appended; when nothing is missing, `text` is the runtime content unchanged (===) so callers can
// skip the write and never churn the file's mtime.
function mergeEnvText(bundledText, runtimeText) {
  const runtime = String(runtimeText ?? '');
  const owned = ownedKeys(runtime);
  const missing = parseEnvEntries(bundledText).filter((e) => !owned.has(e.key));
  if (missing.length === 0) return { text: runtime, added: [] };
  const head = runtime === '' || runtime.endsWith('\n') ? runtime : runtime + '\n';
  const block = '\n# --- added by app update (new keys from the bundled .env; edit freely) ---\n'
    + missing.map((e) => e.raw).join('\n') + '\n';
  return { text: head + block, added: missing.map((e) => e.key) };
}

module.exports = { mergeEnvText, parseEnvEntries, ownedKeys };
