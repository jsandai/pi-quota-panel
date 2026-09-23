import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRows, renderRow, layout, severity, formatReset } from '../src/render.mjs';
import { success, failure } from '../src/poll.mjs';

const NOW = Date.parse('2026-09-15T12:00:00Z');
const at = '2026-09-15T11:00:00Z';
const id = (provider, account, metric) => ({ provider, account, metric });
const quota = (pct, resetAt = '2026-09-15T15:00:00Z') => ({ kind: 'quota', remainingPercent: pct, resetAt, durationMinutes: 300 });
const balance = (cur, total) => ({ kind: 'balance', currency: cur, total, granted: null, purchased: null, available: true });
const acc = (c) => c.repeat(64);

test('severity thresholds match the live panel contract', () => {
  assert.equal(severity(null), 'dim');
  assert.equal(severity(5), 'error');
  assert.equal(severity(20), 'warning');
  assert.equal(severity(80), 'success');
});

test('formatReset: today -> HH:MM, other day -> M/D HH:MM', () => {
  assert.equal(formatReset('2026-09-15T18:30:00', NOW), '18:30');
  assert.equal(formatReset('2026-09-18T07:00:00', NOW), '9/18 07:00');
  assert.equal(formatReset(null, NOW), '');
  assert.equal(formatReset('garbage', NOW), '');
});

test('groupRows gives each present provider a cell, in fixed order', () => {
  const a1 = acc('a'), a2 = acc('b');
  const readings = [
    success(id('devin', a1, 'quota:weekly'), quota(0), at),
    success(id('devin-alt', a2, 'quota:weekly'), quota(49), at),
    success(id('claude-bridge', acc('c'), 'quota:session'), quota(78), at),
    success(id('openai-codex', acc('d'), 'quota:5h'), quota(100), at),
    success(id('antigravity', acc('e'), 'quota:weekly'), quota(100), at),
    success(id('antigravity', acc('e'), 'quota:external_weekly'), quota(66), at),
    success(id('muse-code', acc('f'), 'quota:weekly'), quota(88), at),
    success(id('deepseek', acc('g'), 'balance:USD'), balance('USD', '0.84'), at),
  ];
  const cells = groupRows(readings, [], { now: NOW });
  const labels = cells.map(c => c.spec.label);
  assert.deepEqual(labels, ['D1', 'D2', 'Claude', 'Codex', 'AGY', 'Ext', 'Muse', 'Credits']);
});

test('a second account exposed as its own provider gets its own row', () => {
  // Regression: an extension that registers one provider per account ids them
  // separately (`devin`, `devin-alt`), so a spec asking for "the 2nd account of
  // provider devin" finds nothing and the row silently disappears. The Devin
  // rows are generated from the provider ids actually present instead.
  const readings = [
    success(id('devin', acc('a'), 'quota:weekly'), quota(12), at),
    success(id('devin-alt', acc('b'), 'quota:weekly'), quota(49), at),
  ];
  const cells = groupRows(readings, [], { now: NOW });
  assert.deepEqual(cells.map(c => c.spec.label), ['D1', 'D2']);
  assert.deepEqual(cells.map(c => c.account), [acc('a'), acc('b')]);
  // and a third would appear too, rather than being dropped
  const three = groupRows([...readings, success(id('devin-work', acc('c'), 'quota:weekly'), quota(70), at)], [], { now: NOW });
  assert.deepEqual(three.map(c => c.spec.label), ['D1', 'D2', 'D3']);
  assert.deepEqual(three.map(c => c.account), [acc('a'), acc('b'), acc('c')]);
});

test('a stale reading keeps its value but is marked; failure with no last-good shows error', () => {
  const a = acc('b');
  const stale = success(id('muse-code', a, 'quota:window'), quota(40), '2026-09-14T00:00:00Z');
  const failed = failure(id('muse-code', a, 'quota:weekly'), null, 'timeout', at);
  const cells = groupRows([stale, failed], [], { now: NOW, staleMs: 60_000 });
  assert.equal(cells[0].stale, true);
  const { text } = renderRow(cells[0], { now: NOW });
  assert.ok(text.includes('40%'));
  assert.ok(text.includes('err'));
  assert.ok(text.includes('⚠'));
});

test('credit cells render balances, not quota (DS and OR)', () => {
  const a = acc('g'), b = acc('h');
  const readings = [
    success(id('deepseek', a, 'balance:USD'), balance('USD', '0.84'), at),
    success(id('openrouter', b, 'balance:USD'), balance('USD', '2.51'), at),
  ];
  const cells = groupRows(readings, [], { now: NOW });
  // Both balances share one combined cell so the grid stays two-per-line.
  const credits = cells.find(c => c.spec.key === 'credits');
  assert.ok(credits);
  const text = renderRow(credits, { now: NOW }).text;
  assert.ok(text.includes('DS'), 'shows the deepseek code');
  assert.ok(text.includes('OR'), 'shows the openrouter code');
  assert.ok(text.includes('0.84'));
  assert.ok(text.includes('2.51'));
});

test('layout packs two columns on wide terminals and one on narrow', () => {
  const mk = (provider, metric, pct) =>
    success(id(provider, acc(provider[0]), metric), quota(pct), at);
  const readings = [
    mk('devin', 'quota:weekly', 90),
    mk('claude-bridge', 'quota:session', 30),
    mk('openai-codex', 'quota:5h', 55),
    mk('muse-code', 'quota:weekly', 10),
  ];
  const cells = groupRows(readings, [], { now: NOW });
  const wide = layout(cells, { width: 140, now: NOW });
  assert.equal(wide.length, 2);                       // 4 cells, 2 per line
  const narrow = layout(cells, { width: 40, now: NOW });
  assert.equal(narrow.length, cells.length);          // single column, never drops
});

test('empty snapshot renders a placeholder, not a crash', () => {
  const lines = layout([], { width: 80, now: NOW });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].text.includes('no data'));
});

test('active provider gets the ▸ marker in a reserved slot', () => {
  const a = acc('d');
  const readings = [success(id('openai-codex', a, 'quota:5h'), quota(55), at)];
  const cells = groupRows(readings, [], { now: NOW });
  const { text } = renderRow(cells.find(c => c.spec.key === 'codex'), { now: NOW, activeProvider: 'openai-codex' });
  assert.ok(text.startsWith('▸'));
});

test('a metric that was never measured does not mark the account stale', () => {
  // DeepSeek advertises CNY and USD but an account only has one of them. The
  // absent one is a failure with no value and no freshAt; reading that as
  // "infinitely old" put a permanent stale marker on the credits cell.
  const a = acc('a');
  // measured 30s before NOW, so it is genuinely fresh under a 60s threshold
  const near = new Date(NOW - 30_000).toISOString();
  const measured = success(id('deepseek', a, 'balance:USD'), balance('USD', '8.44'), near);
  const neverMeasured = failure(id('deepseek', a, 'balance:CNY'), null, 'invalid-response', near);
  const cells = groupRows([measured, neverMeasured], [], { now: NOW, staleMs: 60_000 });
  assert.equal(cells[0].stale, false, 'absent is not stale');
  assert.ok(!renderRow(cells[0], { now: NOW }).text.includes('⚠'));
});

test('a genuinely old value is still marked stale', () => {
  // guards that the fix above did not simply disable the marker
  const a = acc('a');
  const old = success(id('deepseek', a, 'balance:USD'), balance('USD', '1.00'), '2026-09-14T00:00:00Z');
  const cells = groupRows([old], [], { now: NOW, staleMs: 60_000 });
  assert.equal(cells[0].stale, true);
  assert.ok(renderRow(cells[0], { now: NOW }).text.includes('⚠'));
});

test('a failed currency does not hide a good balance in the credits cell', () => {
  const a = acc('a');
  const failed = failure(id('deepseek', a, 'balance:CNY'), null, 'invalid-response', at);
  const good = success(id('deepseek', a, 'balance:USD'), balance('USD', '8.44'), at);
  // the failed reading is first, so a naive balances[0] would render "err"
  const cells = groupRows([failed, good], [], { now: NOW });
  const credits = cells.find(c => c.spec.key === 'credits');
  const { text } = renderRow(credits, { now: NOW });
  assert.ok(text.includes('8.44'), `expected the good balance, got: ${text}`);
});

test('a fresh account wins the cell once the stale one is pruned', () => {
  // The reported bug: a rotated credential left a frozen account first in
  // groupRows' order, masking the live account. After pollOnce retires the
  // stale identity, the cell must show the fresh reading.
  const staleAcc = acc('a'), liveAcc = acc('b');
  const masked = groupRows([
    success(id('openai-codex', staleAcc, 'quota:5h'), quota(100), '2026-09-14T11:00:00Z'),
    success(id('openai-codex', liveAcc, 'quota:5h'), quota(40), at),
  ], [], { now: NOW });
  assert.equal(masked[0].account, staleAcc, 'pre-fix: first-in-order account masks the live one');

  const reconciled = groupRows([
    success(id('openai-codex', liveAcc, 'quota:5h'), quota(40), at),
  ], [], { now: NOW });
  assert.equal(reconciled[0].account, liveAcc);
  const five = reconciled[0].quota.get('quota:5h');
  assert.equal(five.value.remainingPercent, 40, 'the live reading renders, not the frozen one');
});
