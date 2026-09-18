import test from "node:test";
import assert from "node:assert/strict";
import { buildRequests, routeFor, accountId } from "../src/providers.mjs";

/** Minimal registry stub matching the pi modelRegistry surface we use. */
function registry({ ids = [], auth = {}, status = {} } = {}) {
  return {
    getAvailable: () => ids.map((p) => ({ provider: p })),
    getProviderAuthStatus: (p) => status[p] ?? { configured: true },
    getProviderAuth: async (p) => auth[p],
  };
}

const apiKey = (k) => ({ auth: { apiKey: k } });

test("routes address a provider to its adapter, and nothing else", () => {
  assert.equal(routeFor("openai-codex")?.adapter, "codex");
  assert.equal(routeFor("deepseek")?.adapter, "deepseek");
  assert.equal(routeFor("openrouter")?.adapter, "openrouter");
  assert.equal(routeFor("muse-code")?.adapter, "muse");
  assert.equal(routeFor("claude-bridge")?.adapter, "claude");
  assert.equal(routeFor("anthropic")?.adapter, "claude");
  assert.equal(routeFor("antigravity")?.adapter, "antigravity");
  assert.equal(routeFor("some-random-provider"), null);
});

test("every provider id an extension registers per account routes to the same adapter", () => {
  // An extension that exposes one provider per account ids them from its own
  // config, so the pattern — not a fixed name — is what matters. `devin-alt` is
  // the live example. (pi-devin constrains ids to /^[a-z][a-z0-9-]*$/, so the
  // separator is always a hyphen; the test pins that rather than guessing.)
  for (const id of ["devin", "devin-alt", "devin-work", "devin-account2"]) {
    assert.equal(routeFor(id)?.adapter, "devin", `${id} should route to devin`);
  }
  // ...but only as a prefix, so an unrelated name cannot be captured.
  assert.equal(routeFor("devintools"), null);
});

test("a token resolved from pi is what gets handed to the adapter", async () => {
  const reg = registry({
    ids: ["openai-codex", "devin", "devin-alt", "deepseek"],
    auth: {
      "openai-codex": apiKey("oauth-access"),
      "devin": apiKey("key-primary"),
      "devin-alt": apiKey("key-secondary"),
      "deepseek": apiKey("sk-deep"),
    },
  });
  const { requests, dropped } = await buildRequests(reg);
  const tokens = Object.fromEntries(requests.map((r) => [r.provider, r.config.token]));
  assert.equal(dropped.length, 0);
  // Two Devin accounts arrive as two providers with two keys, with nothing
  // configured here — which is why this package needs no account config file.
  assert.equal(requests.filter((r) => r.provider.startsWith("devin")).length, 2);
  assert.equal(tokens["devin"], "key-primary");
  assert.equal(tokens["devin-alt"], "key-secondary");
  assert.equal(tokens["deepseek"], "sk-deep");
});

test("a Bearer header is acceptable where a provider resolves auth that way", async () => {
  const reg = registry({
    ids: ["deepseek"],
    auth: { deepseek: { auth: { headers: { Authorization: "Bearer sk-from-header" } } } },
  });
  const { requests } = await buildRequests(reg);
  assert.equal(requests[0].config.token, "sk-from-header");
});

test("a provider with an unresolvable credential is reported, not silently dropped", async () => {
  const reg = registry({ ids: ["deepseek"], auth: {} });
  const { requests, dropped } = await buildRequests(reg);
  assert.equal(requests.length, 0);
  assert.deepEqual(dropped, [{ provider: "deepseek", reason: "no-credential" }]);
});

test("a provider with no adapter is reported as no-route", async () => {
  const reg = registry({ ids: ["some-random-provider"], auth: {} });
  const { dropped } = await buildRequests(reg);
  assert.deepEqual(dropped, [{ provider: "some-random-provider", reason: "no-route" }]);
});

test("an explicitly unconfigured provider is skipped", async () => {
  const reg = registry({ ids: ["deepseek"], auth: { deepseek: apiKey("x") }, status: { deepseek: { configured: false } } });
  const { requests, dropped } = await buildRequests(reg);
  assert.equal(requests.length, 0);
  assert.deepEqual(dropped, [{ provider: "deepseek", reason: "unconfigured" }]);
});

test("muse gets its token file rather than the placeholder pi advertises", async () => {
  // the muse-code provider registers apiKey "muse-code-local"; a token of that
  // value would be rejected by the mint, so the path is passed instead.
  const reg = registry({ ids: ["muse-code"], auth: { "muse-code": apiKey("muse-code-local") } });
  const { requests } = await buildRequests(reg);
  assert.equal(requests[0].adapter, "muse");
  assert.equal(typeof requests[0].config.tokenFile, "string");
  assert.match(requests[0].config.tokenFile, /muse[/\\]auth\.json$/);
  assert.equal(requests[0].config.token, undefined);
});

test("claude and antigravity need nothing from pi", async () => {
  const reg = registry({ ids: ["claude-bridge", "antigravity"], auth: {} });
  const { requests, dropped } = await buildRequests(reg);
  assert.equal(dropped.length, 0, "their provider placeholders must not be mistaken for missing credentials");
  assert.deepEqual(requests.map((r) => r.adapter).sort(), ["antigravity", "claude"]);
  for (const r of requests) assert.deepEqual(r.config, {});
});

test("the account id is a hash, so a token cannot reach a reading", () => {
  const id = accountId("deepseek:sk-super-secret");
  assert.equal(id.length, 16);
  assert.ok(!id.includes("secret"));
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(accountId("x"), accountId("x"), "stable across calls");
  assert.notEqual(accountId("x"), accountId("y"));
});
