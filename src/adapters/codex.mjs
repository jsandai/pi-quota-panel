import { fetchJson } from './http.mjs';

/**
 * Codex (ChatGPT) quota adapter — GET https://chatgpt.com/backend-api/wham/usage
 *
 * The interactive `codex` TUI's `/status` screen reads this same endpoint. We
 * call it directly, so quota costs one ~0.5s request instead of spawning a TUI,
 * waiting for the banner, sending `/status` twice, and killing it.
 *
 * Auth: the OAuth access token (a JWT) plus the ChatGPT account id. The account
 * id is a nested claim in the access token, so we decode the JWT payload here
 * rather than requiring a second credential field over IPC.
 *
 * Response shape:
 *   rate_limit.primary_window   { used_percent, reset_at (epoch s), limit_window_seconds }
 *   rate_limit.secondary_window { … }   (5h and 7d respectively)
 *
 * We emit `quota:5h` / `quota:weekly` as REMAINING percent (100 - used).
 */

const DEFAULT_BASE = 'https://chatgpt.com';

/** Extract chatgpt_account_id from the access-token JWT, or null. */
function accountIdFromJwt(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const auth = claims?.['https://api.openai.com/auth'];
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

const pct = used => Math.max(0, Math.min(100, 100 - used));
const iso = secs => (Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null);

/** The HTTP path: GET the wham/usage rate-limit snapshot. */
async function runHttp(parameters, base, signal) {
  let url;
  try { url = new URL(base); } catch { throw Object.assign(new Error('bad base'), { code: 'invalid-response' }); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
    throw Object.assign(new Error('insecure base'), { code: 'invalid-response' });
  }
  const accountId = parameters.accountId ?? accountIdFromJwt(parameters.token);
  if (!accountId) throw Object.assign(new Error('no account id'), { code: 'invalid-response' });
  const { json } = await fetchJson(new URL('/backend-api/wham/usage', base + '/').toString(), {
    headers: {
      'Authorization': `Bearer ${parameters.token}`,
      'ChatGPT-Account-Id': accountId,
      'Accept': 'application/json',
    },
    signal,
  });
  const rl = json?.rate_limit;
  if (!rl || typeof rl !== 'object') throw Object.assign(new Error('no rate_limit'), { code: 'invalid-response' });
  const observedAt = new Date().toISOString();
  /** @type {Array<{metric:string, value:any, observedAt:string}>} */
  const out = [];
  const push = (metric, w) => {
    if (!w || typeof w.used_percent !== 'number') return;
    out.push({
      metric, observedAt,
      value: {
        kind: 'quota',
        remainingPercent: pct(w.used_percent),
        resetAt: iso(w.reset_at),
        durationMinutes: Number.isFinite(w.limit_window_seconds) ? Math.round(w.limit_window_seconds / 60) : null,
      },
    });
  };
  push('quota:5h', rl.primary_window);
  push('quota:weekly', rl.secondary_window);
  if (!out.length) throw Object.assign(new Error('no windows'), { code: 'invalid-response' });
  return out;
}

/** @type {import('../poll.mjs').Adapter} */
export const codexAdapter = {
  /**
   * @param {{token?:string, accountId?:string, baseUrl?:string}} config
   */
  normalize(config) {
    if (typeof config?.token !== 'string' || !config.token) throw new Error('Invalid codex request');
    const accountId = typeof config.accountId === 'string' && config.accountId
      ? config.accountId : accountIdFromJwt(config.token);
    return {
      capability: /** @type {'quota'} */ ('quota'),
      // Scope to the ChatGPT account id, not the access token: the token is a
      // short-lived JWT that OAuth renewal rotates, and a rotating scope made
      // every renewal mint a new "account" whose predecessor's readings froze
      // in place — and could keep rendering ahead of the live account. A token
      // whose claim cannot be decoded falls back to the raw token, preserving
      // the old behavior for malformed input.
      credentialScope: `codex:${accountId ?? config.token}`,
      parameters: { token: config.token, accountId, baseUrl: config.baseUrl },
      metrics: ['quota:5h', 'quota:weekly'],
    };
  },
  /**
   * @param {{token:string, accountId?:string|null, baseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const base = (parameters.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    return await runHttp(parameters, base, signal);
  },
};
