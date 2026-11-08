import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editApproval, parseApprovalEdit, resolveApproval } from './approval-control.mjs';

function state() {
  return {
    approvals: [
      { id: 'run-a1', status: 'approved', title: 'Old done' },
      { id: 'run-a2', status: 'pending', dept: 'growth', action: 'intel brief', title: 'Ghost Report', summary: 'Publish raw report', buildTask: 'Ghost Report — Publish raw report', exec: { args: [{ title: '[growth] Ghost Report', body: '**Action:** Ghost Report\n\nPublish raw report' }] } },
      { id: 'run-a3', status: 'pending', dept: 'product', action: 'feature PR', title: 'Task controls', summary: 'Add controls', build: 'product', buildTask: 'Task controls. Add controls', exec: { args: [{ title: '[product] Task controls', body: '**Action:** Task controls\n\nAdd controls' }] } },
    ],
    proposals: [{ dept: 'growth', kind: 'intel brief', gatedAction: 'Ghost Report', body: 'Publish raw report' }],
  };
}

test('resolves by run approval number, pending queue index, and unique title words', () => {
  assert.equal(resolveApproval(state(), '2').approval.id, 'run-a2');
  assert.equal(resolveApproval(state(), '1').approval.id, 'run-a2', 'queue index 1 skips decided items');
  assert.equal(resolveApproval(state(), 'Ghost Report').approval.id, 'run-a2');
});

test('parses safe field-specific edit commands and declines normal chat', () => {
  const parsed = parseApprovalEdit('edit approval 2 summary to Publish a redacted weekly report', state());
  assert.equal(parsed.type, 'edit-approval');
  assert.equal(parsed.approval.id, 'run-a2');
  assert.equal(parsed.field, 'summary');
  assert.equal(parseApprovalEdit('edit proposal Task controls target repo to Seen Command', state()).field, 'repo');
  assert.equal(parseApprovalEdit('update approval 2 acceptance criteria to tests pass', state()).field, 'acceptanceCriteria');
  assert.equal(parseApprovalEdit('what is approval 2?', state()), null);
});

test('editing keeps the card, proposal, exec payload, and build task in sync', () => {
  const s = state(); const a = s.approvals[1];
  editApproval(s, a, { field: 'summary', value: 'Publish a redacted weekly report' });
  assert.equal(a.summary, 'Publish a redacted weekly report');
  assert.match(a.exec.args[0].body, /redacted weekly/);
  assert.match(a.buildTask, /redacted weekly/);
  assert.match(s.proposals[0].body, /redacted weekly/);
  assert.equal(a.editHistory.length, 1);
});

test('editing a title updates every downstream title without changing stable approval id', () => {
  const s = state(); const a = s.approvals[1];
  editApproval(s, a, { field: 'title', value: 'Redacted Ghost Report' });
  assert.equal(a.id, 'run-a2');
  assert.equal(a.exec.args[0].title, '[growth] Redacted Ghost Report');
  assert.match(a.exec.args[0].body, /Redacted Ghost Report/);
  assert.equal(s.proposals[0].gatedAction, 'Redacted Ghost Report');
});

test('decided approvals and empty replacements cannot be edited', () => {
  assert.throws(() => editApproval(state(), state().approvals[0], { value: 'x' }), /pending/);
  assert.throws(() => editApproval(state(), state().approvals[1], { value: '  ' }), /empty/);
});

test('engineering repo, target path, and acceptance edits update the exact downstream payload', () => {
  const s = state(); const a = s.approvals[2];
  const originalSummary = a.summary;
  editApproval(s, a, { field: 'repo', value: 'Seen Command' });
  editApproval(s, a, { field: 'targetPath', value: 'engine/server.mjs' });
  editApproval(s, a, { field: 'acceptanceCriteria', value: 'The API and full test gate pass' });
  assert.equal(a.build, 'tool');
  assert.equal(a.targetPath, 'engine/server.mjs');
  assert.equal(a.acceptanceCriteria, 'The API and full test gate pass');
  assert.match(a.buildTask, /Target repository: tool/);
  assert.match(a.buildTask, /Target path: engine\/server\.mjs/);
  assert.match(a.buildTask, /Acceptance criteria: The API and full test gate pass/);
  assert.match(a.exec.args[0].body, /\*\*Target repository:\*\* Seen Command/);
  assert.match(a.exec.args[0].body, /\*\*Target path:\*\* engine\/server\.mjs/);
  assert.match(a.exec.args[0].body, /\*\*Acceptance criteria:\*\* The API and full test gate pass/);
  assert.match(a.exec.args[0].body, new RegExp(originalSummary));
});

test('target repo and path validation block meaningless or unsafe edits', () => {
  const s = state();
  assert.throws(() => editApproval(s, s.approvals[1], { field: 'repo', value: 'product' }), /does not launch/);
  assert.throws(() => editApproval(s, s.approvals[2], { field: 'repo', value: 'somewhere' }), /Seen Command or Seen product/);
  assert.throws(() => editApproval(s, s.approvals[2], { field: 'targetPath', value: '../secret' }), /repo-relative/);
});
