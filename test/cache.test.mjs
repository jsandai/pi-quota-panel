import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, cachePath } from "../src/cache.mjs";
import { success, readingKey } from "../src/poll.mjs";

const id = { provider: "deepseek", account: "abc123", metric: "balance:USD" };
const reading = success(id, { kind: "balance", currency: "USD", total: "0.84", granted: null, purchased: null, available: true }, "2026-09-16T12:00:00Z");

test("a written snapshot reads back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    const path = join(dir, "readings.json");
    const readings = new Map([[readingKey(id), reading]]);
    assert.equal(await writeCache(readings, dir), true);
    const back = await readCache(dir);
    assert.equal(back.size, 1);
    assert.deepEqual(back.get(readingKey(id)).value, reading.value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing cache is a cold start, not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    const back = await readCache(join(dir, "nothing-here"));
    assert.equal(back.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a corrupt or foreign file does not put junk in front of the renderer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    for (const body of ["{not json", "{}", '{"version":99,"readings":[]}', '{"version":1,"readings":"nope"}']) {
      await writeFile(join(dir, "readings.json"), body);
      assert.equal((await readCache(dir)).size, 0, `should ignore: ${body}`);
    }
    // right envelope, malformed entries
    await writeFile(join(dir, "readings.json"), JSON.stringify({
      version: 1,
      readings: [
        { identity: { provider: "p" } },                                   // no account/metric
        { identity: { provider: "p", account: "a", metric: "m" }, value: "string" },
        { identity: { provider: "p", account: "a", metric: "ok" }, value: null, freshAt: null, error: "timeout" },
      ],
    }));
    const back = await readCache(dir);
    assert.equal(back.size, 1, "only the well-formed entry survives");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the cache carries no credential material", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    // account ids are hashes; a token that appeared anywhere would be a bug
    const readings = new Map([[readingKey(id), reading]]);
    await writeCache(readings, dir);
    const raw = await readFile(cachePath(dir), "utf8");
    assert.ok(!raw.includes("sk-"), "no api key shape");
    assert.ok(!raw.includes("Bearer"), "no auth header");
    assert.ok(!/"token"/.test(raw), "no token field");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the snapshot is written 0600 inside a private directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    const root = join(dir, "nested", "state");
    await writeCache(new Map([[readingKey(id), reading]]), root);
    const file = await stat(cachePath(root));
    assert.equal(file.mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the write is atomic: no partial file is ever visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "panel-cache-"));
  try {
    const big = new Map();
    for (let i = 0; i < 400; i += 1) {
      const i2 = { provider: "p", account: `a${i}`, metric: "quota:5h" };
      big.set(readingKey(i2), success(i2, { kind: "quota", remainingPercent: i % 100, resetAt: null }, "2026-09-16T12:00:00Z"));
    }
    // write repeatedly while reading; a reader must never see a truncated file
    let torn = false;
    const reader = (async () => {
      for (let i = 0; i < 60; i += 1) {
        try {
          const parsed = JSON.parse(await readFile(cachePath(dir), "utf8"));
          if (!Array.isArray(parsed.readings) || parsed.readings.length !== 400) torn = true;
        } catch (e) {
          if (e.code !== "ENOENT") torn = true;   // ENOENT just means not written yet
        }
      }
    })();
    for (let i = 0; i < 20; i += 1) await writeCache(big, dir);
    await reader;
    assert.equal(torn, false, "a reader saw a half-written snapshot");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
