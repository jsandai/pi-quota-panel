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

test("a failure keeps the source tag so omarchy's stale window survives", async () => {
  const good = "2026-09-16T12:00:00Z";
  const readings = new Map();
  const id = { provider: "meta", account: accountId("x"), metric: "quota:window" };
  readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 90, resetAt: null }, good, "omarchy"));
  await pollOnce([{ provider: "meta", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ scope: "x", metrics: ["quota:window"], run: async () => { throw Object.assign(new Error("gone"), { code: "unavailable" }); } }),
    }),
    readings,
  });
  const reading = readings.get(readingKey(id));
  assert.equal(reading.source, "omarchy", "a failed refresh must not drop the source tag");
  assert.equal(reading.freshAt, good);
  assert.equal(reading.error, "unavailable");
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

test("a superseded account is retired once its provider reads successfully", async () => {
  // The codex rotation case: a renewed credential minted a new account id and
  // the old one's readings froze. Once the provider answers successfully under
  // the new identity, the old account's frozen readings must go — they can
  // otherwise keep rendering ahead of the live account.
  const readings = new Map();
  const stale = { provider: "p", account: accountId("old-scope"), metric: "quota:5h" };
  readings.set(readingKey(stale), success(stale, { kind: "quota", remainingPercent: 99, resetAt: null }, "2026-09-21T16:00:00Z"));

  await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ scope: "new-scope", run: async () => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 40, resetAt: null }, observedAt: "2026-09-23T03:00:00Z" }] }),
    }),
    readings,
  });

  assert.equal(readings.has(readingKey(stale)), false, "the superseded account's frozen reading must go");
  const live = [...readings.values()].find((r) => r.identity.account === accountId("new-scope"));
  assert.equal(live.value.remainingPercent, 40, "the live account's reading remains");
});

test("readings survive a cycle with no requests at all", async () => {
  // An empty request list (e.g. every auth resolution failed that cycle) says
  // nothing about which accounts exist — wiping the map would lose last-good
  // data on exactly the transient failure the stale marker exists to show.
  const readings = new Map();
  const id = { provider: "p", account: accountId("x"), metric: "quota:5h" };
  readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 55, resetAt: null }, "2026-09-23T02:00:00Z"));

  await pollOnce([], { adapters: registry({}), readings });
  assert.equal(readings.get(readingKey(id))?.value?.remainingPercent, 55);
});

test("a failed or empty observation does not retire sibling accounts", async () => {
  // Only a provider that produced at least one observation this cycle may
  // retire its other accounts. A failed job — or a resolved-but-empty one —
  // proves nothing about which of its accounts are real.
  for (const run of [
    async () => { throw Object.assign(new Error("nope"), { code: "transport" }); },
    async () => [],
  ]) {
    const readings = new Map();
    const stale = { provider: "p", account: accountId("old-scope"), metric: "quota:5h" };
    readings.set(readingKey(stale), success(stale, { kind: "quota", remainingPercent: 99, resetAt: null }, "2026-09-21T16:00:00Z"));
    await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
      adapters: registry({ a: adapter({ scope: "new-scope", run }) }),
      readings,
    });
    assert.ok(readings.has(readingKey(stale)), "no successful observation => nothing is retired");
  }
});

test("a skipped provider keeps its readings", async () => {
  // Unknown adapter and normalize() throwing both drop the job before it runs;
  // neither may cost the provider its last-good readings.
  for (const request of [
    { provider: "p", adapter: "no-such-adapter", config: {} },
    { provider: "p", adapter: "a", config: {} },
  ]) {
    const readings = new Map();
    const id = { provider: "p", account: accountId("x"), metric: "quota:5h" };
    readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 55, resetAt: null }, "2026-09-23T02:00:00Z"));
    await pollOnce([request], {
      adapters: registry({ a: adapter({ normalize: () => { throw new Error("bad config"); }, run: async () => [] }) }),
      readings,
    });
    assert.ok(readings.has(readingKey(id)), `skipped job must not prune (adapter: ${request.adapter})`);
  }
});

test("a second still-live account of the same provider is not retired", async () => {
  // Two configured accounts, both polled: the one that succeeds retires only
  // accounts absent from this cycle entirely — never a sibling account whose
  // own job merely failed.
  const readings = new Map();
  for (const scope of ["acct-1", "acct-2"]) {
    const id = { provider: "p", account: accountId(scope), metric: "quota:5h" };
    readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 10, resetAt: null }, "2026-09-23T02:00:00Z"));
  }
  await pollOnce(
    [{ provider: "p", adapter: "a", config: { which: "acct-1" } }, { provider: "p", adapter: "a", config: { which: "acct-2" } }],
    {
      adapters: registry({
        a: {
          normalize: (config) => ({ capability: "quota", credentialScope: config.which, parameters: {}, metrics: ["quota:5h"] }),
          run: async (_p, _s) => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 50, resetAt: null }, observedAt: "2026-09-23T03:00:00Z" }],
        },
      }),
      readings,
      concurrency: 1,
    },
  );
  assert.ok(readings.has(readingKey({ provider: "p", account: accountId("acct-1"), metric: "quota:5h" })));
  assert.ok(readings.has(readingKey({ provider: "p", account: accountId("acct-2"), metric: "quota:5h" })),
    "a configured sibling account is never pruned");
});

test("a transient failure keeps its identity — pruning is not failure handling", async () => {
  // A job that fails still resolved an account this cycle, so its readings stay
  // (marked with the error) rather than being dropped alongside truly gone
  // accounts.
  const readings = new Map();
  const id = { provider: "p", account: accountId("x"), metric: "quota:5h" };
  readings.set(readingKey(id), success(id, { kind: "quota", remainingPercent: 55, resetAt: null }, "2026-09-23T02:00:00Z"));

  await pollOnce([{ provider: "p", adapter: "a", config: {} }], {
    adapters: registry({
      a: adapter({ scope: "x", run: async () => { throw Object.assign(new Error("nope"), { code: "transport" }); } }),
    }),
    readings,
  });

  const kept = readings.get(readingKey(id));
  assert.ok(kept, "a failed attempt must not prune the account's last-good");
  assert.equal(kept.value.remainingPercent, 55);
  assert.equal(kept.error, "transport");
});

test("two rotated tokens for one account update a single identity across polls", async () => {
  // End-to-end for the codex fix: normalize() maps each token to its account
  // claim, so a renewal lands on the same reading instead of minting a twin.
  const jwt = (acct, tag) => `h.${Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: acct }, nonce: tag,
  })).toString("base64url")}.${tag}`;
  const codexish = {
    normalize: (config) => {
      const payload = JSON.parse(Buffer.from(config.token.split(".")[1], "base64url").toString());
      const acct = payload["https://api.openai.com/auth"].chatgpt_account_id;
      return { capability: "quota", credentialScope: `codex:${acct}`, parameters: {}, metrics: ["quota:5h"] };
    },
    run: async (_p, _s) => [{ metric: "quota:5h", value: { kind: "quota", remainingPercent: 50, resetAt: null }, observedAt: "2026-09-23T03:00:00Z" }],
  };
  const readings = new Map();
  const adapters = registry({ codex: codexish });
  await pollOnce([{ provider: "openai-codex", adapter: "codex", config: { token: jwt("acct-1", "t1") } }], { adapters, readings });
  await pollOnce([{ provider: "openai-codex", adapter: "codex", config: { token: jwt("acct-1", "t2") } }], { adapters, readings });
  const accounts = new Set([...readings.values()].map((r) => r.identity.account));
  assert.equal(accounts.size, 1, "renewal must not mint a second account");
});
