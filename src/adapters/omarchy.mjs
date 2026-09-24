import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Shared reader for Omarchy's per-agent usage records.
 *
 * Omarchy polls each provider's usage source on a system-wide cadence and
 * writes one display-ready record per agent to
 *   $XDG_STATE_HOME/omarchy/agents/usage/<agent>.json
 * (~/.local/state/omarchy/agents/usage/<agent>.json). Reading that file means
 * every pi session consumes Omarchy's existing probe result instead of each
 * hitting the provider itself — the per-process polling that used to run here
 * is what got the direct claude probe rate-limited (HTTP 429).
 *
 * The record's `limits` array carries { label, percent, resetsAt } where
 * `percent` is a USED fraction in [0,1] (0.04 = 4% used), so
 * remainingPercent = (1 - percent) * 100.
 *
 * Freshness caveat: the record's `updatedAt` is when Omarchy WROTE the record,
 * not when the provider was last measured — Omarchy republishes last-good
 * limits after a failed probe. So a stalled collector still ages the row
 * (updatedAt stops advancing), but a collector that is running yet failing its
 * probe keeps updatedAt fresh while serving stale limits. That distinction is
 * not recoverable from this file; it is the price of a read-only tap.
 *
 * This package only reads the file; it never runs the collector and never
 * talks to the provider. A missing, malformed, or wrong-agent record is
 * `unavailable`/`invalid-response`, so the panel keeps last-good and marks the
 * row stale rather than inventing a number.
 */

/** Resolve the agent's usage record path. @param {string} agent */
export function omarchyUsagePath(agent) {
  const state = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(state, 'omarchy', 'agents', 'usage', `${agent}.json`);
}

/** Read and parse the record, or null when absent/unreadable. @param {string} path */
async function readRecord(path) {
  try {
    const d = JSON.parse(await readFile(path, 'utf8'));
    return d && typeof d === 'object' ? d : null;
  } catch {
    return null;
  }
}

/** @param {any} v */
const iso = v => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * Build an adapter that reads one agent's Omarchy record.
 *
 * @param {string} agent   the record file name and expected `id` (claude, codex)
 * @param {Array<{match:RegExp, metric:string, idleWhenAbsent?:boolean}>} windows
 *   label → our metric. The regex must be anchored to the general window label
 *   (e.g. /^session/i, /^weekly/i) — a loose /week/ also matches a model-scoped
 *   extra like "Fable Weekly" and would steal the slot. First match wins.
 *   `idleWhenAbsent`: when the record is valid and fresh but this window is
 *   simply absent — Omarchy drops a limit once its resetsAt passes, so a closed
 *   5h session window vanishes between uses — emit it as 100% remaining with no
 *   reset rather than letting the poller mark the missing metric stale. Only
 *   set this on windows that legitimately disappear when idle (the short
 *   session window), never on the always-present weekly.
 * @returns {import('../poll.mjs').Adapter}
 */
export function omarchyAdapter(agent, windows) {
  return {
    /**
     * The credentialScope is the record path: the identity is the file, not a
     * credential, so it is stable across token rotations and carries no secret.
     * @param {{usageFile?:string}} [config]
     */
    normalize(config) {
      const file = config?.usageFile ?? omarchyUsagePath(agent);
      return {
        capability: /** @type {'quota'} */ ('quota'),
        credentialScope: `omarchy:${file}`,
        parameters: { usageFile: file },
        metrics: windows.map(w => w.metric),
      };
    },
    /** @param {{usageFile:string}} parameters */
    async run(parameters) {
      const record = await readRecord(parameters.usageFile ?? omarchyUsagePath(agent));
      if (!record) throw Object.assign(new Error(`no omarchy ${agent} record`), { code: 'unavailable' });
      // Reject a record that is not this agent's, or whose shape we do not
      // recognize: a wrong file must not be read as this provider's quota.
      if (record.id !== agent || !Array.isArray(record.limits)) {
        throw Object.assign(new Error(`bad omarchy ${agent} record`), { code: 'invalid-response' });
      }
      // observedAt is the record's updatedAt, never now: see the freshness
      // caveat above. A record with no parseable updatedAt cannot be aged
      // honestly, so it is rejected rather than reported as fresh.
      const observedAt = iso(record.updatedAt);
      if (!observedAt) throw Object.assign(new Error(`omarchy ${agent} record has no updatedAt`), { code: 'invalid-response' });
      /** @type {Array<{metric:string, value:any, observedAt:string, source?:string}>} */
      const out = [];
      const seen = new Set();
      for (const limit of record.limits) {
        if (!limit || typeof limit !== 'object') continue;
        const label = String(limit.label ?? limit.title ?? '');
        const spec = windows.find(w => w.match.test(label));
        if (!spec || seen.has(spec.metric)) continue;
        // percent must be a real number in [0,1]. A label that MATCHES a window
        // but carries a bad percent is a corrupt measurement — fail the run
        // rather than fabricate a number or let idleWhenAbsent mask it.
        const used = typeof limit.percent === 'number' && Number.isFinite(limit.percent)
          ? limit.percent : NaN;
        if (!(used >= 0 && used <= 1)) {
          throw Object.assign(new Error(`bad ${agent} percent for "${label}"`), { code: 'invalid-response' });
        }
        seen.add(spec.metric);
        out.push({
          metric: spec.metric, observedAt, source: 'omarchy',
          value: {
            kind: 'quota',
            // Keep full precision; the render layer rounds for display.
            remainingPercent: Math.max(0, Math.min(100, (1 - used) * 100)),
            resetAt: iso(limit.resetsAt),
            durationMinutes: null,
          },
        });
      }
      // A declared window the record did not produce: for a window that is
      // legitimately absent while idle (the 5h session between uses), report
      // 100% remaining rather than leaving the metric unmeasured — absent here
      // means "nothing is being consumed", not "the probe failed". The record
      // already proved itself valid and fresh above, so this is not fabricated.
      for (const spec of windows) {
        if (seen.has(spec.metric) || !spec.idleWhenAbsent) continue;
        out.push({
          metric: spec.metric, observedAt, source: 'omarchy',
          value: { kind: 'quota', remainingPercent: 100, resetAt: null, durationMinutes: null },
        });
      }
      if (!out.length) throw Object.assign(new Error(`no ${agent} limits`), { code: 'invalid-response' });
      return out;
    },
  };
}
