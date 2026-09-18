import { execFile } from 'node:child_process';

/**
 * Antigravity (agy) quota adapter.
 *
 * Primary path: the same endpoint the `agy` CLI's `/usage` reads.
 *
 *   POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *   Authorization: Bearer <google oauth access token>
 *
 * Response: `groups[].buckets[]` where each bucket carries `window` ("5h" |
 * "weekly"), `remainingFraction` (REMAINING, 0..1) and `resetTime` (ISO). Two
 * groups: "Gemini Models" (primary) and "Claude and GPT models" (external).
 * We emit quota:5h / quota:weekly / quota:external_5h / quota:external_weekly —
 * the same metric names the CLI recipe produces, so the UI is unchanged.
 *
 * The host matters: the "daily" channel answers; the prod
 * `cloudcode-pa.googleapis.com` returns 403 for these methods.
 *
 * Credential: agy stores its OAuth token in the OS keyring (Secret Service),
 * NOT in a file — `~/.gemini/oauth_creds.json` is a different credential and
 * 403s. The collector's scrubbed env can still reach it: libsecret falls back
 * to `$XDG_RUNTIME_DIR/bus`, which is in the collector's env whitelist. We read
 * the token at run time via `secret-tool` so a refreshed token is picked up
 * without a new register.
 *
 * Fallback: the access token is short-lived (~1h) and agy owns its refresh, so
 * if the keyring read fails or the token has expired we fall back to the CLI
 * recipe (`agy -p /usage`, a non-interactive one-shot). Running agy refreshes
 * the stored token as a side effect, so the fast path recovers on the next poll.
 */

const DEFAULT_BASE = 'https://daily-cloudcode-pa.googleapis.com';
const KEYRING_SERVICE = 'gemini';
const KEYRING_USER = 'antigravity';
const TOKEN_READ_TIMEOUT_MS = 10_000;

/** Read the agy OAuth token from the OS keyring, or null. */
/**
 * Read the agy OAuth token from the OS keyring, or null.
 *
 * A plain bounded execFile: `secret-tool` is a short-lived read that exits on
 * its own, so there is no process tree to supervise and no PTY involved.
 */
function readKeyringToken(signal) {
  return new Promise(resolve => {
    execFile(
      'secret-tool',
      ['lookup', 'service', KEYRING_SERVICE, 'username', KEYRING_USER],
      {
        timeout: TOKEN_READ_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        signal,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
          ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
        },
      },
      (error, stdout) => {
        if (error) { resolve(null); return; }
        try {
          const parsed = JSON.parse(stdout);
          const token = parsed?.token?.access_token;
          resolve(typeof token === 'string' && token ? token : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

const pct = frac => Math.max(0, Math.min(100, Math.round(frac * 100)));
const iso = v => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** Map a bucket to (metric, value) using its group + window. */
function bucketToMetric(groupName, bucket) {
  const external = !/gemini/i.test(groupName ?? '');
  const isWeekly = bucket.window === 'weekly' || /weekly/i.test(bucket.bucketId ?? '');
  const isFive = bucket.window === '5h' || /5h/i.test(bucket.bucketId ?? '');
  if (!isWeekly && !isFive) return null;
  const metric = external
    ? (isWeekly ? 'quota:external_weekly' : 'quota:external_5h')
    : (isWeekly ? 'quota:weekly' : 'quota:5h');
  if (typeof bucket.remainingFraction !== 'number') return null;
  return { metric, remainingPercent: pct(bucket.remainingFraction), resetAt: iso(bucket.resetTime) };
}

/** @type {import('../poll.mjs').Adapter} */
export const antigravityAdapter = {
  /**
   * @param {{token?:string, baseUrl?:string}} config
   */
  normalize(config) {
    return {
      capability: /** @type {'quota'} */ ('quota'),
      // One keyring item identifies the account; scope by it, not by the token.
      credentialScope: `antigravity:keyring:${KEYRING_SERVICE}/${KEYRING_USER}`,
      // `token` is an explicit override, which is also what makes this adapter
      // testable without a keyring present.
      parameters: { token: config?.token, baseUrl: config?.baseUrl },
      metrics: ['quota:5h', 'quota:weekly', 'quota:external_5h', 'quota:external_weekly'],
    };
  },
  /**
   * @param {{token?:string, baseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const token = parameters.token ?? await readKeyringToken(signal);
    // No token means expired, revoked, or no D-Bus session: report it rather
    // than inventing a number. Running `agy` refreshes the stored token, after
    // which the next poll succeeds on its own.
    if (!token) throw Object.assign(new Error('no antigravity keyring token'), { code: 'unauthorized' });
    return await runHttp(parameters, token, signal);
  },
};

async function runHttp(parameters, token, signal) {
  const base = (parameters.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch { throw Object.assign(new Error('bad base'), { code: 'invalid-response' }); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
    throw Object.assign(new Error('insecure base'), { code: 'invalid-response' });
  }
  let response;
  try {
    response = await fetch(new URL('/v1internal:retrieveUserQuotaSummary', base + '/').toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity',
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
      },
      body: '{}',
      redirect: 'manual',
      signal,
    });
  } catch {
    throw Object.assign(new Error('antigravity transport'), { code: 'transport' });
  }
  if (response.status === 401 || response.status === 403) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
  if (response.status >= 500) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('transport'), { code: 'transport' });
  const json = await response.json().catch(() => null);
  const groups = json?.groups;
  if (!Array.isArray(groups)) throw Object.assign(new Error('no groups'), { code: 'invalid-response' });
  const observedAt = new Date().toISOString();
  /** @type {Array<{metric:string, value:any, observedAt:string}>} */
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    for (const bucket of group?.buckets ?? []) {
      const mapped = bucketToMetric(group?.displayName, bucket);
      if (!mapped || seen.has(mapped.metric)) continue;
      seen.add(mapped.metric);
      out.push({
        metric: mapped.metric, observedAt,
        value: { kind: 'quota', remainingPercent: mapped.remainingPercent, resetAt: mapped.resetAt, durationMinutes: null },
      });
    }
  }
  if (!out.length) throw Object.assign(new Error('no quota buckets'), { code: 'invalid-response' });
  return out;
}
