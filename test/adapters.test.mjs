import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexAdapter } from "../src/adapters/codex.mjs";
import { devinAdapter } from "../src/adapters/devin.mjs";
import { claudeAdapter } from "../src/adapters/claude.mjs";
import { antigravityAdapter } from "../src/adapters/antigravity.mjs";
import { museAdapter } from "../src/adapters/muse.mjs";
import { deepseekAdapter } from "../src/adapters/deepseek.mjs";
import { openrouterAdapter } from "../src/adapters/openrouter.mjs";

// Every adapter has exactly one job: issue one request to one host and parse it.
// These drive each against a local mock so the request shape and the parse are
// pinned without touching a network or a credential.

/** Start a mock server; returns { base, seen, close }. */
async function mock(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    await handler(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

const json = (res, obj, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

test("codex reads rate_limit windows and sends the account id", async () => {
  const m = await mock((_req, res) =>
    json(res, {
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 6, reset_at: 1789600685, limit_window_seconds: 18000 },
        secondary_window: { used_percent: 16, reset_at: 1790165252, limit_window_seconds: 604800 },
      },
    }),
  );
  try {
    // A real-looking JWT so the adapter can pull the nested account claim.
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
    ).toString("base64url");
    const token = `h.${payload}.s`;
    const spec = codexAdapter.normalize({ token, baseUrl: m.base });
    assert.equal(spec.parameters.accountId, "acct-1");
    const out = await codexAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.equal(byMetric["quota:5h"].remainingPercent, 94); // used -> remaining
    assert.equal(byMetric["quota:weekly"].remainingPercent, 84);
    assert.equal(byMetric["quota:5h"].durationMinutes, 300);
    assert.equal(m.seen[0].url, "/backend-api/wham/usage");
    assert.equal(m.seen[0].headers["chatgpt-account-id"], "acct-1");
    assert.equal(m.seen[0].headers.authorization, `Bearer ${token}`);
  } finally {
    m.close();
  }
});

test("devin sends Basic <key>-<key>, not base64, and decodes plan_status", async () => {
  // Build the protobuf GetUserStatusResponse: f1 -> f13 -> {f15 weekly, f18 reset}.
  const vint = (n) => { const o = []; while (n > 0x7f) { o.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
  const fld = (num, body) => Buffer.concat([vint((num << 3) | 2), vint(body.length), body]);
  const vf = (num, n) => Buffer.concat([vint(num << 3), vint(n)]);
  const planStatus = Buffer.concat([vf(15, 49), vf(18, 1789948800)]);
  const userStatus = fld(13, planStatus);
  const responseBody = fld(1, userStatus);

  const m = await mock((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/proto" });
    res.end(responseBody);
  });
  try {
    const key = "devin-session-token$abc.def.ghi";
    const spec = devinAdapter.normalize({ token: key, baseUrl: m.base });
    const out = await devinAdapter.run(spec.parameters, new AbortController().signal);
    assert.equal(out.length, 1);
    assert.equal(out[0].metric, "quota:weekly");
    assert.equal(out[0].value.remainingPercent, 49);
    assert.equal(out[0].value.resetAt, new Date(1789948800 * 1000).toISOString());
    assert.equal(m.seen[0].headers.authorization, `Basic ${key}-${key}`);
    assert.equal(m.seen[0].headers["connect-protocol-version"], "1");
    // The key travels in the protobuf body too, on the client-metadata field.
    assert.ok(m.seen[0].body.includes(key));
  } finally {
    m.close();
  }
});

test("devin rejects an empty token up front", () => {
  assert.throws(() => devinAdapter.normalize({}), /Invalid devin request/);
});

test("claude maps utilization (used) to remaining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-claude-"));
  try {
    const creds = join(dir, "credentials.json");
    await writeFile(creds, JSON.stringify({ claudeAiOauth: { accessToken: "tok-123" } }));
    const m = await mock((_req, res) =>
      json(res, {
        five_hour: { utilization: 42, resets_at: "2026-09-16T20:20:00.963644+00:00" },
        seven_day: { utilization: 97, resets_at: "2026-09-17T08:59:59.963666+00:00" },
      }),
    );
    try {
      const spec = claudeAdapter.normalize({ credentialsFile: creds, baseUrl: m.base });
      const out = await claudeAdapter.run(spec.parameters, new AbortController().signal);
      const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
      assert.equal(byMetric["quota:session"].remainingPercent, 58);
      assert.equal(byMetric["quota:week"].remainingPercent, 3);
      assert.equal(m.seen[0].headers.authorization, "Bearer tok-123");
      assert.equal(m.seen[0].url, "/api/oauth/usage");
    } finally {
      m.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude with no credential is unauthorized, never a fabricated value", async () => {
  const spec = claudeAdapter.normalize({ credentialsFile: "/nonexistent/creds.json", baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => claudeAdapter.run(spec.parameters, new AbortController().signal),
    (e) => e.code === "unauthorized",
  );
});

test("antigravity maps groups and buckets to the four quota windows", async () => {
  const m = await mock((_req, res) =>
    json(res, {
      groups: [
        { displayName: "Gemini Models", buckets: [
          { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.9975063, resetTime: "2026-09-23T20:10:55Z" },
          { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9850379, resetTime: "2026-09-17T01:10:55Z" },
        ] },
        { displayName: "Claude and GPT models", buckets: [
          { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.6643313, resetTime: "2026-09-19T19:18:07Z" },
          { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-09-17T01:29:36Z" },
        ] },
      ],
    }),
  );
  try {
    const spec = antigravityAdapter.normalize({ token: "k", baseUrl: m.base });
    const out = await antigravityAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value.remainingPercent]));
    assert.deepEqual(byMetric, {
      "quota:weekly": 100, "quota:5h": 99,
      "quota:external_weekly": 66, "quota:external_5h": 100,
    });
    assert.equal(m.seen[0].url, "/v1internal:retrieveUserQuotaSummary");
    assert.equal(m.seen[0].method, "POST");
  } finally {
    m.close();
  }
});

test("muse reads subs_usage and sends a Bearer token", async () => {
  const m = await mock((_req, res) =>
    json(res, {
      subs_usage: {
        window: { used_percent: 0, window_duration_mins: 300, resets_at: 1789601423 },
        weekly: { used_percent: 1, resets_at: 1789948800 },
      },
    }),
  );
  try {
    const spec = museAdapter.normalize({ token: "muse-tok", mintBaseUrl: m.base });
    const out = await museAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.equal(byMetric["quota:window"].remainingPercent, 100);
    assert.equal(byMetric["quota:weekly"].remainingPercent, 99);
    assert.equal(m.seen[0].headers.authorization, "Bearer muse-tok");
    assert.equal(m.seen[0].url, "/muse-code/key");
  } finally {
    m.close();
  }
});

test("muse with no subs_usage reports an error rather than 0%", async () => {
  const m = await mock((_req, res) => json(res, { is_subs_active: true, subs_tier_name: "Everyday" }));
  try {
    const spec = museAdapter.normalize({ token: "t", mintBaseUrl: m.base });
    await assert.rejects(
      () => museAdapter.run(spec.parameters, new AbortController().signal),
      (e) => e.code === "invalid-response",
    );
  } finally {
    m.close();
  }
});

test("deepseek preserves decimal strings and never combines currencies", async () => {
  const m = await mock((_req, res) =>
    json(res, {
      is_available: true,
      balance_infos: [
        { currency: "USD", total_balance: "0.84", granted_balance: "0.00", topped_up_balance: "0.84" },
        { currency: "CNY", total_balance: "12.30", granted_balance: "2.00", topped_up_balance: "10.30" },
      ],
    }),
  );
  try {
    const spec = deepseekAdapter.normalize({ token: "sk-x", baseUrl: m.base });
    const out = await deepseekAdapter.run(spec.parameters, new AbortController().signal);
    assert.deepEqual(out.map((o) => o.metric), ["balance:USD", "balance:CNY"]);
    assert.equal(out[0].value.total, "0.84");   // exact string, not a float
    assert.equal(out[1].value.granted, "2.00");
    assert.equal(m.seen[0].url, "/user/balance");
  } finally {
    m.close();
  }
});

test("openrouter reports remaining credit from total minus usage", async () => {
  const m = await mock((_req, res) => json(res, { data: { total_credits: 10, total_usage: 7.486528292 } }));
  try {
    const spec = openrouterAdapter.normalize({ token: "or-x", baseUrl: m.base });
    const out = await openrouterAdapter.run(spec.parameters, new AbortController().signal);
    assert.equal(out[0].metric, "balance:USD");
    assert.equal(out[0].value.total, "2.51");
    assert.equal(m.seen[0].url, "/api/v1/credits");
  } finally {
    m.close();
  }
});

test("every adapter refuses an insecure non-loopback base", async () => {
  const cases = [
    [codexAdapter, { token: "t", baseUrl: "http://example.com" }],
    [devinAdapter, { token: "t", baseUrl: "http://example.com" }],
    [museAdapter, { token: "t", mintBaseUrl: "http://example.com" }],
    [deepseekAdapter, { token: "t", baseUrl: "http://example.com" }],
    [openrouterAdapter, { token: "t", baseUrl: "http://example.com" }],
    [antigravityAdapter, { token: "t", baseUrl: "http://example.com" }],
  ];
  for (const [adapter, config] of cases) {
    const spec = adapter.normalize(config);
    await assert.rejects(
      () => adapter.run(spec.parameters, new AbortController().signal),
      (e) => e.code === "invalid-response",
      `${adapter === museAdapter ? "muse" : ""} should reject a plaintext remote origin`,
    );
  }
});

test("an HTTP 401 becomes unauthorized, not a parse error", async () => {
  const m = await mock((_req, res) => json(res, { error: "nope" }, 401));
  try {
    for (const [adapter, config] of [
      [codexAdapter, { token: "t", baseUrl: m.base, accountId: "a" }],
      [deepseekAdapter, { token: "t", baseUrl: m.base }],
      [openrouterAdapter, { token: "t", baseUrl: m.base }],
    ]) {
      const spec = adapter.normalize(config);
      await assert.rejects(
        () => adapter.run(spec.parameters, new AbortController().signal),
        (e) => e.code === "unauthorized",
      );
    }
  } finally {
    m.close();
  }
});

test("codex identity follows the account, not the rotating access token", () => {
  // OAuth renewal hands the panel a fresh access token each time. Two tokens
  // carrying the same chatgpt_account_id claim must normalize to ONE credential
  // scope — otherwise every renewal mints a new "account" whose predecessor's
  // readings freeze and can keep rendering ahead of the live one.
  const jwt = (accountId, tag) => {
    const payload = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, nonce: tag }),
    ).toString("base64url");
    return `h.${payload}.${tag}`;
  };
  const first = codexAdapter.normalize({ token: jwt("acct-1", "tok1") });
  const renewed = codexAdapter.normalize({ token: jwt("acct-1", "tok2") });
  assert.equal(first.credentialScope, renewed.credentialScope,
    "renewal must update the same identity, not mint a new account");

  const other = codexAdapter.normalize({ token: jwt("acct-2", "tok1") });
  assert.notEqual(other.credentialScope, first.credentialScope,
    "genuinely different accounts stay distinct");

  const undecodable = codexAdapter.normalize({ token: "not-a-jwt" });
  assert.equal(undecodable.credentialScope, "codex:not-a-jwt",
    "a token without a decodable claim falls back to the token itself");
});
