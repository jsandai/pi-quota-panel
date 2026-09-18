import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fetchJson } from './http.mjs';

/**
 * Muse quota adapter — subscription quota, no inference.
 *
 * Two sources, tried in order:
 *
 *  1. The key mint (primary): POST {TBH_MINT_BASE_URL|https://api.meta.ai}/muse-code/key
 *     {onboard:false} with Bearer <subscription access token>. Returns
 *     `subs_usage.{window,weekly}` with `used_percent`, `resets_at` (epoch
 *     seconds), `window_duration_mins` and `tier`, alongside `is_subs_active`
 *     and `subs_tier_name`. One ~0.4s request, always fresh, no subprocess —
 *     this is the efficient path and the normal one.
 *
 *     NOTE: the field is omitted (not falsified) in some subscription states —
 *     observed consistently absent on 2026-09-16 before the account had a
 *     usage snapshot, and consistently present afterwards (6/6 calls). When it
 *     is absent we must NOT assume 0% used: an absent measurement reported as a
 *     number is the failure mode this adapter exists to avoid. In practice the
 *     field reappears once the account has any activity — a single message to
 *     muse re-ups it — so an absent `subs_usage` is reported as an error and
 *     left to go stale rather than fabricated.
 *
 * The token does NOT come from pi's auth store: the muse-code provider
 * registers a literal placeholder apiKey ("muse-code-local"), so
 * getProviderAuth returns no real credential. The live subscription token
 * lives in `~/.config/muse/auth.json` → `providers.meta.access_token` and is
 * rewritten by the muse CLI on refresh. `config.tokenFile` points at that
 * file; the collector reads it at run time so a rotated token is picked up
 * without a new register. `config.token` remains as an explicit override
 * (tests, future pi-side resolution). The token is used only as the Bearer
 * header; it is never persisted, logged, or sent to any other origin.
 */

const DEFAULT_MINT = 'https://api.meta.ai';
const DEFAULT_TOKEN_FILE = join(homedir(), '.config', 'muse', 'auth.json');

/** Read the current muse subscription token from auth.json, or null. */
async function readTokenFile(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const auth = JSON.parse(raw);
    const token = auth?.providers?.meta?.access_token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;    // missing/corrupt file resolves to no-token, not a crash
  }
}

/** @param {string|undefined} override */
function mintBase(override) {
  const base = (override ?? DEFAULT_MINT).replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch { throw Object.assign(new Error('bad mint base'), { code: 'invalid-response' }); }
  // Only HTTPS (or loopback http for tests) may carry the Bearer token.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
    throw Object.assign(new Error('insecure mint base'), { code: 'invalid-response' });
  }
  return url;
}

const pct = used => Math.max(0, Math.min(100, 100 - used));
const iso = secs => (Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null);

/** Build observations from mint `subs_usage`; [] when the shape is absent. */
function fromMint(usage, observedAt) {
  const out = [];
  if (!usage || typeof usage !== 'object') return out;
  for (const [metric, window] of [['quota:window', usage.window], ['quota:weekly', usage.weekly]]) {
    if (!window || typeof window !== 'object' || typeof window.used_percent !== 'number') continue;
    out.push({
      metric, observedAt,
      value: {
        kind: 'quota',
        remainingPercent: pct(window.used_percent),
        resetAt: iso(window.resets_at),
        durationMinutes: Number.isFinite(window.window_duration_mins) ? window.window_duration_mins : null,
      },
    });
  }
  return out;
}

export const MUSE_TOKEN_FILE = DEFAULT_TOKEN_FILE;

/** @type {import('../poll.mjs').Adapter} */
export const museAdapter = {
  /**
   * @param {{token?:string, tokenFile?:string, mintBaseUrl?:string}} config
   */
  normalize(config) {
    const token = typeof config?.token === 'string' && config.token ? config.token : null;
    const tokenFile = typeof config?.tokenFile === 'string' && config.tokenFile ? config.tokenFile : null;
    if (!token && !tokenFile) throw new Error('Invalid muse request');
    return {
      capability: /** @type {'quota'} */ ('quota'),
      // Scope to the credential file path (or explicit token) so a different
      // credential context is a different account; the rotating token value
      // itself must not be the scope or every refresh would split the account.
      credentialScope: `muse:${tokenFile ?? token}`,
      parameters: { token, tokenFile, mintBaseUrl: config.mintBaseUrl },
      metrics: ['quota:window', 'quota:weekly'],
    };
  },
  /**
   * @param {{token?:string, tokenFile?:string, mintBaseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const observedAt = new Date().toISOString();
    // Resolve the token at run time: an explicit token wins, otherwise read
    // the (possibly just-rotated) auth.json. No token => unauthorized, not a
    // request with a placeholder Bearer.
    const token = parameters.token ?? (parameters.tokenFile ? await readTokenFile(parameters.tokenFile) : null);
    if (!token) throw Object.assign(new Error('no muse token'), { code: 'unauthorized' });

    // The mint. Only reached when a real token resolved. A failure — transport,
    // timeout, auth — propagates with its own code; an absent subs_usage is an
    // honest invalid-response, never a fabricated number.
    const base = mintBase(parameters.mintBaseUrl);
    const { json } = await fetchJson(new URL('/muse-code/key', base + '/').toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ onboard: false }),
      signal,
    });
    const out = fromMint(json?.subs_usage, observedAt);
    if (!out.length) {
      throw Object.assign(new Error('muse mint sent no subs_usage'), { code: 'invalid-response' });
    }
    return out;
  },
};
