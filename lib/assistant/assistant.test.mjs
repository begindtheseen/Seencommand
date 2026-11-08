// Run: node --test lib/assistant/assistant.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, loadSkills, matchSkills, diffSkills, skillsContext, createSkillWatcher } from './skills.mjs';
import { rankRecall, relatedApprovals, noteFact, createAssistantRoutes } from './routes.mjs';
import { terminalScript, openClaudeTerminal } from '../terminal.mjs';

const SKILL = (name, when = 'weekly review, catch me up') => `---\nname: ${name}\ndescription: Review the week.\nwhen: ${when}\n---\n1. run brief\n2. report`;

test('skills: parsed from files, the Mac folder wins a name clash, bad files are reported not loaded', () => {
  const a = mkdtempSync(join(tmpdir(), 'sk-a-')), b = mkdtempSync(join(tmpdir(), 'sk-b-'));
  writeFileSync(join(a, 'weekly.md'), SKILL('weekly-review'));
  writeFileSync(join(b, 'weekly.md'), SKILL('weekly-review', 'monday'));
  writeFileSync(join(a, 'bad.md'), 'no header here');
  writeFileSync(join(a, 'noname.md'), '---\nname: Bad Name!\ndescription: x\n---\nsteps');
  const r = loadSkills({ dirs: [a, b] });
  assert.equal(r.skills.length, 1);
  assert.equal(r.skills[0].origin, 'yours');
  assert.deepEqual(r.skills[0].when, ['monday']);
  assert.equal(r.errors.length, 2, r.errors.join(' | '));
  assert.match(parseSkill('---\nname: x1\n---\nsteps').error, /description/);
});

test('skills: matched by name or a whole trigger phrase, never inside another word', () => {
  const skills = [parseSkill(SKILL('weekly-review')), parseSkill('---\nname: fill-company\ndescription: d\nwhen: fill, build out\n---\nsteps')];
  assert.deepEqual(matchSkills('can you catch me up on everything?', skills).map((s) => s.name), ['weekly-review']);
  assert.deepEqual(matchSkills('run the weekly review', skills).map((s) => s.name), ['weekly-review']);
  assert.deepEqual(matchSkills('fill Home Depot', skills).map((s) => s.name), ['fill-company']);
  assert.deepEqual(matchSkills('we fulfill orders', skills), []);
  const ctx = skillsContext('catch me up', { skills, changes: { added: ['fill-company'], updated: [], removed: ['old'] } });
  assert.match(ctx, /SKILL "weekly-review"/); assert.match(ctx, /added fill-company; removed old/);
});

test('skills watcher: announces an add, an edit and a removal once each — and nothing on the first start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sk-w-')); const state = join(mkdtempSync(join(tmpdir(), 'sk-s-')), 'seen.json');
  writeFileSync(join(dir, 'a.md'), SKILL('alpha'));
  const seen = [];
  const w = createSkillWatcher({ dirs: [dir], statePath: state, onChange: (d) => seen.push(d) });
  w.check(); assert.equal(seen.length, 0, 'first start sets the baseline');
  writeFileSync(join(dir, 'b.md'), SKILL('beta')); w.check();
  writeFileSync(join(dir, 'a.md'), SKILL('alpha', 'changed phrase')); w.check();
  rmSync(join(dir, 'b.md')); w.check(); w.check();
  assert.deepEqual(seen.map((d) => [d.added, d.updated, d.removed]), [[['beta'], [], []], [[], ['alpha'], []], [[], [], ['beta']]]);
  const taken = w.takeChanges();
  assert.deepEqual([taken.added, taken.updated, taken.removed], [['beta'], ['alpha'], ['beta']]);
  assert.equal(w.takeChanges(), null, 'announced in chat once');
  const again = createSkillWatcher({ dirs: [dir], statePath: state, onChange: (d) => seen.push(d) }); again.check();
  assert.equal(seen.length, 3, 'a restart with no change announces nothing');
  assert.deepEqual(diffSkills({ x: '1' }, []).removed, ['x']);
});

test('recall ranks by shared words (subject counts double) and finds related pending approvals', () => {
  const facts = [{ subject: 'owner:vision', predicate: 'chatbot', object: 'the chatbot must act, not just read', valid_from: '2026-10-21' }, { subject: 'seen:jobs', predicate: 'count', object: '79985 listings' }, { subject: 'pricing', predicate: 'pro', object: '$9 a month' }];
  const r = rankRecall('is the chatbot able to act?', facts, [{ date: '2026-10-20', heading: 'Board Room', text: 'chatbot refused to run a search' }]);
  assert.equal(r.facts[0].predicate, 'chatbot'); assert.equal(r.facts.length, 1);
  assert.equal(r.lines.length, 1);
  const appr = [{ id: 'a1', status: 'pending', title: 'Fix the chatbot search refusal', summary: 'let the chatbot run searches', action: 'build' }, { id: 'a2', status: 'approved', title: 'chatbot search', summary: 'chatbot', action: '' }];
  assert.deepEqual(relatedApprovals('the chatbot will not run a search', appr).map((a) => a.id), ['a1']);
  assert.deepEqual(noteFact({ kind: 'vision', topic: 'Chat Bot!', text: 'acts for me' }), { subject: 'owner:vision', predicate: 'chat-bot', object: 'acts for me' });
  assert.equal(noteFact({ kind: 'vision', text: 'no topic' }), null);
});

function fakeRes() { const out = {}; return { out, res: { writeHead(c) { out.code = c; }, end(b) { out.body = JSON.parse(b); } } }; }
const jsonFn = (res, code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); };

test('note: a repeat is a no-op, a change supersedes, related approvals come back; remote callers are refused', async () => {
  const facts = [{ subject: 'owner:vision', predicate: 'chatbot', object: 'acts for me' }];
  const writes = [];
  const h = createAssistantRoutes({ json: jsonFn, readBody: async (req) => req.body, localOnly: (req) => req.local !== false, loadState: () => ({ approvals: [{ id: 'p9', status: 'pending', title: 'Chatbot can approve fixes for me', summary: 'chatbot approve fixes', action: '' }] }),
    currentFacts: () => facts, recordFact: async (f) => { writes.push(f); facts.splice(0, 1, f); return { ok: true }; }, skills: null, searches: () => [], openTerminal: async () => ({ ok: true }) });
  const qs = new URLSearchParams();
  let r = fakeRes(); await h({ method: 'POST', body: { kind: 'vision', topic: 'chatbot', text: 'acts for me' } }, r.res, '/api/assistant/note', qs);
  assert.equal(r.out.body.result, 'already_known'); assert.equal(writes.length, 0);
  r = fakeRes(); await h({ method: 'POST', body: { kind: 'vision', topic: 'chatbot', text: 'acts for me and can approve fixes' } }, r.res, '/api/assistant/note', qs);
  assert.equal(r.out.body.result, 'superseded'); assert.equal(r.out.body.previous, 'acts for me');
  assert.deepEqual(r.out.body.approvals.map((a) => a.id), ['p9']);
  r = fakeRes(); await h({ method: 'GET', local: false }, r.res, '/api/assistant/brief', qs);
  assert.equal(r.out.code, 403);
  assert.equal(await h({ method: 'GET' }, fakeRes().res, '/api/home', qs), false, 'other routes pass through');
});

test('terminal: the Terminal script quotes the folder and the first message safely; non-Mac says so', async () => {
  const { line, osa } = terminalScript({ dir: "/Users/b/My 'Seen'", prompt: 'fix "it" now; rm -rf /', bin: 'claude' });
  assert.equal(line, `cd '/Users/b/My '\\''Seen'\\''' && 'claude' 'fix "it" now; rm -rf /'`);
  assert.match(osa, /do script "cd '\/Users\/b\/My '\\\\''Seen'\\\\''' && 'claude' 'fix \\"it\\" now; rm -rf \/'"/);
  assert.equal((await openClaudeTerminal({ repo: 'seen' }, { platform: 'linux' })).ok, false);
  let ran = null;
  const r = await openClaudeTerminal({ repo: 'command' }, { platform: 'darwin', exists: () => true, run: (bin, args, o, cb) => { ran = [bin, args]; cb(null); } });
  assert.equal(r.ok, true); assert.equal(ran[0], 'osascript');
  assert.equal((await openClaudeTerminal({ repo: 'nope' }, { platform: 'darwin' })).ok, false);
});

test('brief: carries a compact tickets block — counts and only what needs Brandon', async () => {
  const h = createAssistantRoutes({ json: jsonFn, readBody: async () => ({}), localOnly: () => true, loadState: () => ({}), currentFacts: () => [], recordFact: async () => ({ ok: true }), skills: null, searches: () => [], openTerminal: async () => ({ ok: true }),
    ticketsSummary: async () => ({ active: 4, unclaimed: 2, readyForAI: 1, claimed: 1, needsOwner: [{ id: 'tkt-aaaaaaaaaa', title: 'Fix X', why: 'merge_ready', prUrl: 'https://github.com/begindtheseen/Seen/pull/3', body: 'b' }] }) });
  const r = fakeRes(); await h({ method: 'GET' }, r.res, '/api/assistant/brief', new URLSearchParams());
  assert.equal(r.out.code, 200);
  assert.deepEqual(r.out.body.tickets, { active: 4, unclaimed: 2, readyForAI: 1, claimed: 1, needsYou: [{ id: 'tkt-aaaaaaaaaa', title: 'Fix X', why: 'merge_ready', pr: 'https://github.com/begindtheseen/Seen/pull/3' }] });
  const h2 = createAssistantRoutes({ json: jsonFn, readBody: async () => ({}), localOnly: () => true, loadState: () => ({}), currentFacts: () => [], recordFact: async () => ({ ok: true }), skills: null, searches: () => [], openTerminal: async () => ({ ok: true }),
    ticketsSummary: async () => { throw new Error('no vault'); } });
  const r2 = fakeRes(); await h2({ method: 'GET' }, r2.res, '/api/assistant/brief', new URLSearchParams());
  assert.equal(r2.out.code, 200); assert.equal(r2.out.body.tickets, null, 'a ticket read failure never breaks the brief');
});
