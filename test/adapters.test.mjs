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

test("codex reads Omarchy's codex record and maps used fraction to remaining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-codex-"));
  try {
    const usageFile = join(dir, "codex.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "codex", updatedAt: "2026-09-23T14:48:45.162251+00:00",
      limits: [
        { label: "5h window", percent: 0.34, resetsAt: "2026-09-23T17:33:18+00:00" },
        { label: "Weekly (7-day)", percent: 0.05, resetsAt: "2026-09-30T12:33:18+00:00" },
      ],
    }));
    const spec = codexAdapter.normalize({ usageFile });
    const out = await codexAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    // Full precision is kept; the render layer rounds for display.
    assert.ok(Math.abs(byMetric["quota:5h"].remainingPercent - 66) < 1e-6);   // 1 - 0.34
    assert.ok(Math.abs(byMetric["quota:weekly"].remainingPercent - 95) < 1e-6); // 1 - 0.05
    assert.equal(byMetric["quota:5h"].resetAt, "2026-09-23T17:33:18.000Z");
    // observedAt tracks the record's updatedAt, not the read time.
    assert.equal(out[0].observedAt, "2026-09-23T14:48:45.162Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("codex with no Omarchy record is unavailable, never a fabricated value", async () => {
  const spec = codexAdapter.normalize({ usageFile: "/nonexistent/codex.json" });
  await assert.rejects(
    () => codexAdapter.run(spec.parameters, new AbortController().signal),
    (e) => e.code === "unavailable",
  );
});

test("a record for the wrong agent, or with a bad percent, is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-bad-"));
  try {
    // Wrong agent id must not be read as this provider's quota.
    const wrongId = join(dir, "a.json");
    await writeFile(wrongId, JSON.stringify({ id: "claude", updatedAt: "2026-09-23T14:00:00Z", limits: [{ label: "5h window", percent: 0.5 }] }));
    await assert.rejects(
      () => codexAdapter.run(codexAdapter.normalize({ usageFile: wrongId }).parameters, new AbortController().signal),
      (e) => e.code === "invalid-response",
    );
    // A null/empty percent would otherwise coerce to 0 and fabricate 100%.
    const badPct = join(dir, "b.json");
    await writeFile(badPct, JSON.stringify({ id: "codex", updatedAt: "2026-09-23T14:00:00Z", limits: [{ label: "5h window", percent: null }] }));
    await assert.rejects(
      () => codexAdapter.run(codexAdapter.normalize({ usageFile: badPct }).parameters, new AbortController().signal),
      (e) => e.code === "invalid-response",
    );
    // Missing updatedAt cannot be aged honestly, so it is rejected.
    const noTs = join(dir, "c.json");
    await writeFile(noTs, JSON.stringify({ id: "codex", limits: [{ label: "5h window", percent: 0.5 }] }));
    await assert.rejects(
      () => codexAdapter.run(codexAdapter.normalize({ usageFile: noTs }).parameters, new AbortController().signal),
      (e) => e.code === "invalid-response",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
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

test("claude reads Omarchy's claude record and maps used fraction to remaining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-claude-"));
  try {
    const usageFile = join(dir, "claude.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "claude", updatedAt: "2026-09-23T14:48:44.104846+00:00",
      limits: [
        // Scoped extra FIRST: it must not steal the weekly slot.
        { label: "Fable Weekly", percent: 0.06, resetsAt: "2026-09-24T09:00:00+00:00" },
        { label: "Session (5-hour)", percent: 0.42, resetsAt: "2026-09-16T20:20:00+00:00" },
        { label: "Weekly (7-day)", percent: 0.97, resetsAt: "2026-09-17T08:59:59+00:00" },
      ],
    }));
    const spec = claudeAdapter.normalize({ usageFile });
    const out = await claudeAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.ok(Math.abs(byMetric["quota:session"].remainingPercent - 58) < 1e-6); // 1 - 0.42
    assert.ok(Math.abs(byMetric["quota:week"].remainingPercent - 3) < 1e-6);      // 1 - 0.97
    assert.equal(out.length, 2);                                  // Fable Weekly dropped
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude reports an absent session window as idle (100%), not stale", async () => {
  // Omarchy drops a limit once its resetsAt passes, so a closed 5h session
  // window vanishes from the record between uses. With the record valid and
  // fresh, that absence must read as 100% remaining, not a stale/failed metric.
  const dir = await mkdtemp(join(tmpdir(), "panel-claude-idle-"));
  try {
    const usageFile = join(dir, "claude.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "claude", updatedAt: "2026-09-24T04:30:00+00:00",
      limits: [
        // No Session (5-hour) entry — the window closed and Claude is idle.
        { label: "Weekly (7-day)", percent: 0.44, resetsAt: "2026-09-24T08:59:59+00:00" },
        { label: "Fable Weekly", percent: 0.06, resetsAt: "2026-09-24T08:59:59+00:00" },
      ],
    }));
    const spec = claudeAdapter.normalize({ usageFile });
    const out = await claudeAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.equal(byMetric["quota:session"].remainingPercent, 100);
    assert.equal(byMetric["quota:session"].resetAt, null);
    assert.ok(Math.abs(byMetric["quota:week"].remainingPercent - 56) < 1e-6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("claude with no Omarchy record is unavailable, never a fabricated value", async () => {
  const spec = claudeAdapter.normalize({ usageFile: "/nonexistent/claude.json" });
  await assert.rejects(
    () => claudeAdapter.run(spec.parameters, new AbortController().signal),
    (e) => e.code === "unavailable",
  );
});

test("antigravity reads Omarchy's gemini record into the four quota windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-agy-"));
  try {
    const usageFile = join(dir, "gemini.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "gemini", updatedAt: "2026-09-23T18:49:49.677598+00:00",
      limits: [
        { label: "5h window", percent: 0.0, resetsAt: "2026-09-23T23:49:35Z" },
        { label: "Weekly (7-day)", percent: 0.0061, resetsAt: "2026-09-23T20:10:55Z" },
        { label: "Claude/GPT 5h", percent: 0.0, resetsAt: "2026-09-23T23:49:35Z" },
        { label: "Claude/GPT Weekly (7-day)", percent: 0.0, resetsAt: "2026-09-30T18:49:35Z" },
      ],
    }));
    const spec = antigravityAdapter.normalize({ usageFile });
    const out = await antigravityAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value.remainingPercent]));
    // The Claude/GPT pair must fill the EXTERNAL slots, never the plain ones.
    assert.deepEqual(Object.keys(byMetric).sort(), [
      "quota:5h", "quota:external_5h", "quota:external_weekly", "quota:weekly",
    ]);
    assert.ok(Math.abs(byMetric["quota:weekly"] - 99.39) < 0.01); // 1 - 0.0061
    assert.equal(byMetric["quota:5h"], 100);
    assert.equal(byMetric["quota:external_5h"], 100);
    assert.equal(byMetric["quota:external_weekly"], 100);
    assert.equal(out[0].source, "omarchy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("muse reads Omarchy's muse record and maps used fraction to remaining", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-muse-"));
  try {
    const usageFile = join(dir, "muse.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "muse", updatedAt: "2026-09-23T18:24:04.158334+00:00",
      limits: [
        { label: "5h window", percent: 0.06, resetsAt: "2026-09-23T19:14:58+00:00" },
        { label: "Weekly (7-day)", percent: 0.05, resetsAt: "2026-09-28T00:00:00+00:00" },
      ],
    }));
    const spec = museAdapter.normalize({ usageFile });
    const out = await museAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.ok(Math.abs(byMetric["quota:window"].remainingPercent - 94) < 1e-6);  // 1 - 0.06
    assert.ok(Math.abs(byMetric["quota:weekly"].remainingPercent - 95) < 1e-6);  // 1 - 0.05
    assert.equal(byMetric["quota:window"].resetAt, "2026-09-23T19:14:58.000Z");
    assert.equal(out[0].source, "omarchy");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("muse matches a non-5h short window by duration label", async () => {
  // The short-window label is "<N>h window" from window_duration_mins, so a
  // 3h window must still land in quota:window, not be dropped.
  const dir = await mkdtemp(join(tmpdir(), "panel-muse3h-"));
  try {
    const usageFile = join(dir, "muse.json");
    await writeFile(usageFile, JSON.stringify({
      schemaVersion: 1, id: "muse", updatedAt: "2026-09-23T18:24:04Z",
      limits: [
        { label: "3h window", percent: 0.5, resetsAt: "2026-09-23T21:00:00+00:00" },
        { label: "Weekly (7-day)", percent: 0.1, resetsAt: "2026-09-28T00:00:00+00:00" },
      ],
    }));
    const spec = museAdapter.normalize({ usageFile });
    const out = await museAdapter.run(spec.parameters, new AbortController().signal);
    const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]));
    assert.ok(Math.abs(byMetric["quota:window"].remainingPercent - 50) < 1e-6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("muse with no Omarchy record is unavailable, never a fabricated value", async () => {
  const spec = museAdapter.normalize({ usageFile: "/nonexistent/muse.json" });
  await assert.rejects(
    () => museAdapter.run(spec.parameters, new AbortController().signal),
    (e) => e.code === "unavailable",
  );
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

test("every HTTP adapter refuses an insecure non-loopback base", async () => {
  const cases = [
    [devinAdapter, { token: "t", baseUrl: "http://example.com" }],
    [deepseekAdapter, { token: "t", baseUrl: "http://example.com" }],
    [openrouterAdapter, { token: "t", baseUrl: "http://example.com" }],
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

test("claude/codex identity is the Omarchy record path, not a credential", () => {
  // The identity is the file the adapter reads, so it stays stable across the
  // token rotations that used to mint a new account on every OAuth renewal.
  const a = claudeAdapter.normalize({ usageFile: "/x/claude.json" });
  const b = claudeAdapter.normalize({ usageFile: "/x/claude.json" });
  assert.equal(a.credentialScope, b.credentialScope);
  const other = claudeAdapter.normalize({ usageFile: "/x/other.json" });
  assert.notEqual(other.credentialScope, a.credentialScope);
  // No credential material ever enters the scope.
  assert.ok(a.credentialScope.startsWith("omarchy:"));
});
