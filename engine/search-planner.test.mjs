// Run: node --test engine/search-planner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan, planChatSearch } from './search-planner.mjs';
import { parseSearchCommand, planSearch } from './search.mjs';

const model = (obj, delay = 0) => async () => { if (delay) await new Promise((r) => setTimeout(r, delay)); return { text: typeof obj === 'string' ? obj : `Here you go:\n${JSON.stringify(obj)}` }; };

test('an employer not on Seen yet is still a company search, with the roles asked for', async () => {
  const msg = 'aggregate nasa jobs and import to seenjobs';
  const parsed = parseSearchCommand(msg);
  const p = await planChatSearch(msg, parsed, { catalog: [{ company: 'Walmart', active_listings: 9 }], reasonFn: model({ target: 'company', company: 'NASA', titles: [], locations: [], careers_url: 'https://www.nasa.gov/careers/', methods: [], why: 'NASA is a federal employer; its jobs are on its careers site and USAJOBS.' }) });
  assert.equal(p.planned, true);
  assert.equal(p.input.kind, 'company');
  assert.equal(p.input.url, 'https://www.nasa.gov/careers/');
  const plan = planSearch(p.input, [{ company: 'Walmart', active_listings: 9 }]);
  assert.equal(plan.kind, 'company'); assert.equal(plan.company, 'NASA');
  assert.ok(plan.methods.includes('career_site') && plan.methods.includes('applicant_reports'));
});

test('a field becomes the titles a recruiter would search, in the places asked for', async () => {
  const msg = 'find welder jobs in Texas';
  const p = await planChatSearch(msg, parseSearchCommand(msg), { reasonFn: model({ target: 'field', field: 'welder', titles: ['fabricator', 'pipe welder', 'MIG welder', 'welder'], locations: ['Texas'], methods: [], why: 'Welding roles are posted under several titles.' }) });
  const plan = planSearch(p.input, []);
  assert.equal(plan.kind, 'field');
  assert.deepEqual(plan.titles, ['welder', 'fabricator', 'pipe welder', 'MIG welder']);
  assert.deepEqual(plan.locations, ['Texas']);
});

test("the owner's own words win: a reports request never turns into a job pull", async () => {
  const msg = 'collect applicant reports for Home Depot';
  const p = await planChatSearch(msg, parseSearchCommand(msg), { reasonFn: model({ target: 'company', company: 'Home Depot', methods: ['career_site', 'indeed'], why: 'x' }) });
  assert.deepEqual(p.input.methods, ['applicant_reports', 'company_intel']);
});

test('a bad, empty, slow or unreachable model never blocks: the parser plan runs', async () => {
  const msg = 'search acme technician';
  const parsed = parseSearchCommand(msg);
  for (const reasonFn of [model('no json here'), model({ target: 'planet', company: 'x' }), model({ target: 'company', company: '' }), model({ target: 'company', company: 'DROP TABLE;--<script>' }), async () => { throw new Error('down'); }]) {
    const p = await planChatSearch(msg, parsed, { reasonFn });
    assert.equal(p.planned, false);
    assert.deepEqual(p.input, { text: 'acme technician', keywords: '', url: null, methods: null });
  }
  const t0 = Date.now();
  const slow = await planChatSearch(msg, parsed, { reasonFn: model({ target: 'company', company: 'Acme' }, 5000), timeoutMs: 100 });
  assert.equal(slow.planned, false);
  assert.ok(Date.now() - t0 < 3000, 'a slow model is cut off');
});

test('checks: invented careers pages must be https, junk titles and places are dropped', () => {
  const c = checkPlan({ target: 'company', company: 'Acme', titles: ['technician', '', 'x'.repeat(200), 'Acme'], locations: ['Ohio', 'Ohio', '', 'Remote'], careers_url: 'http://acme.example/jobs', methods: ['seen_sources', 'indeed'] }, {});
  assert.equal(c.input.url, null, 'http is refused');
  assert.equal(c.input.keywords, 'technician');
  assert.deepEqual(c.input.locations, ['Ohio', 'Remote']);
  assert.deepEqual(c.input.methods, ['indeed'], 'seen_sources is a field method');
});
