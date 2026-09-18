import test from "node:test";
import assert from "node:assert/strict";
import { pollOnce, readingKey, success, failure } from "../src/poll.mjs";
import { accountId } from "../src/providers.mjs";

/**
 * The poller's job is to be honest about what it does and does not know. These
 * pin the two rules that matter: an absent measurement is never a number, and a
 * failure never advances freshness.
 */

const READING = null;

/** An adapter stub that does whatever the test needs. */
const adapter = (opts) => ({
  normalize: opts.normalize ?? (() => ({
    capability: "quota", credentialScope: opts.scope ?? "s",
    parameters: opts.parameters ?? {}, metrics: opts.metrics ?? ["quota:5h"],
  })),
  run: opts.run,
});

const registry = (adapters) => new Map(Object.entries(adapters));

test("a successful poll records value and freshness", async () => {
  const at = "2026-09-16T12:00:00Z";
  const readings = await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 42, resetAt: null }, observedAt: at }] }),
    }),
  });
  const [reading] = [...readings.values()];
  assert.equal(reading.value.remainingPercent, 42);
  assert.equal(reading.freshAt, at);
  assert.equal(reading.error, null);
});

test("a failure with no last-good records the error and no value", async () => {
  const readings = await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ run: async () => { throw Object.assign(new Error("nope"), { code: "timeout" }); } }),
    }),
  });
  const [reading] = [...readings.values()];
  assert.equal(reading.value, null, "an absent measurement must not become a number");
  assert.equal(reading.freshAt, null);
  assert.equal(reading.error, "timeout");
});

test("a failure keeps last-good but does NOT advance freshness", async () => {
  const good = "2026-09-16T12:00:00Z";
  const readings = new Map();
  // The poller records under the hashed account, so seed the same way.
  const id = { provider: "p", account: accountId("x"), metric: "quota:5h" };
  readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 42, resetAt: null }, good));
  await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ scope: "x", run: async () => { throw Object.assign(new Error("nope"), { code: "transport" }); } }),
    }),
    readings,
  });
  const reading = readings.get(readingKey(id));
  assert.equal(reading.value.remainingPercent, 42, "keeps the last good value so the row does not blank");
  assert.equal(reading.freshAt, good, "freshness must stay put so it ages visibly");
  assert.equal(reading.error, "transport");
});

test("an unknown error code is not passed through verbatim", async () => {
  const readings = await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ run: async () => { throw Object.assign(new Error("Bearer sk-secret rejected"), { code: "weird-raw-thing" }); } }),
    }),
  });
  const [reading] = [...readings.values()];
  assert.equal(reading.error, "transport");
  assert.ok(!JSON.stringify(reading).includes("sk-secret"), "no raw message may reach a reading");
});

test("a metric the adapter omits is only recorded if a value existed before", async () => {
  const metrics = ["quota:5h", "quota:weekly"];
  const readings = await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({
        scope: "x", metrics,
        // returns only one of its two declared metrics
        run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 10, resetAt: null }, observedAt: "2026-09-16T12:00:00Z" }],
      }),
    }),
  });
  assert.equal(readings.size, 1, "a metric never once observed is not worth an error row");

  const withPrior = new Map();
  const account = accountId("x");
  const prior = { provider: "p", account, metric: "quota:weekly" };
  withPrior.set(readingKey(prior), success(prior, { kind: "quota", remainingPercent: 80, resetAt: null }, "2026-09-16T11:00:00Z"));
  await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ scope: "x", metrics, run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 10, resetAt: null }, observedAt: "2026-09-16T12:00:00Z" }] }),
    }),
    readings: withPrior,
  });
  const weekly = withPrior.get(readingKey(prior));
  assert.equal(weekly.value.remainingPercent, 80, "last-good is kept");
  assert.equal(weekly.error, "invalid-response", "but the omission is recorded");
});

test("one bad provider does not stop the others", async () => {
  const readings = await pollOnce(
    [
      { provider: "bad", adapter: "bad", config: {} },
      { provider: "good", adapter: "good", config: {} },
    ],
    {
      adapters: registry({
        bad: adapter({ run: async () => { throw Object.assign(new Error("x"), { code: "unavailable" }); } }),
        good: adapter({ run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 7, resetAt: null }, observedAt: "2026-09-16T12:00:00Z" }] }),
      }),
    },
  );
  const byProvider = Object.fromEntries([...readings.values()].map((r) => [r.identity.provider, r]));
  assert.equal(byProvider.good.value.remainingPercent, 7);
  assert.equal(byProvider.bad.error, "unavailable");
});

test("an unknown adapter or a malformed request is skipped, not fatal", async () => {
  const readings = await pollOnce(
    [
      { provider: "p1", adapter: "no-such-adapter", config: {} },
      { provider: "p2", adapter: "a", config: {} },
    ],
    {
      adapters: registry({
        a: adapter({ normalize: () => { throw new Error("Invalid request"); }, run: async () => [] }),
      }),
    },
  );
  assert.equal(readings.size, 0);
});

test("an adapter that ignores its abort is bounded by the poller's own timeout", async () => {
  const started = Date.now();
  const readings = await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      // never resolves: simulates a hung socket
      a: adapter({ run: () => new Promise(() => {}) }),
    }),
    timeoutMs: 60,
  });
  assert.equal(readings.size, 1);
  const [reading] = [...readings.values()];
  assert.equal(reading.error, "timeout");
  assert.ok(Date.now() - started < 2000, "must not wait for the hung adapter");
});

test("onReadings fires so a caller can repaint before the slowest provider lands", async () => {
  let calls = 0;
  await pollOnce(
    [
      { provider: "fast", adapter: "fast", config: {} },
      { provider: "slow", adapter: "slow", config: {} },
    ],
    {
      adapters: registry({
        fast: adapter({ scope: "f", run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 1, resetAt: null }, observedAt: "x" }] }),
        slow: adapter({ scope: "s", run: async () => { await new Promise((r) => setTimeout(r, 30)); return [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 2, resetAt: null }, observedAt: "x" }]; } }),
      }),
      concurrency: 2,
      onReadings: () => { calls += 1; },
    },
  );
  assert.ok(calls >= 2, "notified per completion, not only at the end");
});

test('an optional metric that was never reported leaves no failure behind', async () => {
  // DeepSeek advertises CNY and USD but an account has one currency. The absent
  // one must not sit on the account as a permanent invalid-response, yet a
  // metric we HAD a value for and then lost is still worth reporting.
  const metrics = ['balance:USD', 'balance:CNY', 'balance:EUR'];
  const account = accountId('x');
  const readings = new Map();
  const eur = { provider: 'p', account, metric: 'balance:EUR' };
  // a currency we previously saw a value for, then stopped seeing
  readings.set(readingKey(eur), success(eur, { kind: 'balance', currency: 'EUR', total: '5.00' }, '2026-09-16T10:00:00Z'));
  readings.set(readingKey({ provider: 'p', account, metric: 'balance:CNY' }),
    failure({ provider: 'p', account, metric: 'balance:CNY' }, null, 'invalid-response', '2026-09-16T11:00:00Z'));

  await pollOnce([{ provider: 'p', adapter: 'a', config: {} }], {
    adapters: registry({
      a: adapter({
        scope: 'x', metrics,
        run: async () => [{ metric: 'balance:USD', value: { kind: 'balance', currency: 'USD', total: '8.44' }, observedAt: '2026-09-16T12:00:00Z' }],
      }),
    }),
    readings,
  });

  assert.equal(readings.has(readingKey({ provider: 'p', account, metric: 'balance:CNY' })), false,
    'a never-seen currency must not be recorded as a failure');
  const eurAfter = readings.get(readingKey(eur));
  assert.ok(eurAfter, 'a currency we had a value for stays visible');
  assert.equal(eurAfter.value.total, '5.00', 'keeping last-good');
  assert.equal(eurAfter.error, 'invalid-response', 'and the loss is recorded');
});
