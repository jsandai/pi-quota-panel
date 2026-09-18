import { fetchJson } from './http.mjs';

/**
 * OpenRouter credits adapter — GET https://openrouter.ai/api/v1/credits
 *
 * Returns `data.total_credits` (purchased, USD) and `data.total_usage`
 * (consumed, USD). Remaining = total_credits - total_usage. We emit a single
 * `balance:USD` metric carrying the remaining credit as a decimal string.
 * No inference, no other API calls.
 *
 * The API key arrives in `config.token`, resolved pi-side from the provider's
 * stored auth and passed over authenticated IPC.
 */

const BASE = 'https://openrouter.ai';

/** Round a number to a clean decimal string (credits are fractional USD). */
function dec(n) {
  if (!Number.isFinite(n)) return null;
  // Keep cents precision; strip trailing zeros for a tidy "2.51".
  return String(Math.round(n * 100) / 100);
}

/** @type {import('../poll.mjs').Adapter} */
export const openrouterAdapter = {
  /**
   * @param {{token?:string, baseUrl?:string}} config
   */
  normalize(config) {
    if (typeof config?.token !== 'string' || !config.token) throw new Error('Invalid openrouter request');
    return {
      capability: /** @type {'balance'} */ ('balance'),
      credentialScope: `openrouter:${config.token}`,
      parameters: { token: config.token, baseUrl: config.baseUrl },
      metrics: ['balance:USD'],
    };
  },
  /**
   * @param {{token:string, baseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const base = (parameters.baseUrl ?? BASE).replace(/\/+$/, '');
    let url;
    try { url = new URL(base); } catch { throw Object.assign(new Error('bad base'), { code: 'invalid-response' }); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      throw Object.assign(new Error('insecure base'), { code: 'invalid-response' });
    }
    const { json } = await fetchJson(new URL('/api/v1/credits', base + '/').toString(), {
      headers: { 'Authorization': `Bearer ${parameters.token}` },
      signal,
    });
    const data = json?.data;
    if (!data || typeof data !== 'object') throw Object.assign(new Error('no data'), { code: 'invalid-response' });
    const credits = Number(data.total_credits);
    const usage = Number(data.total_usage);
    if (!Number.isFinite(credits) || !Number.isFinite(usage)) {
      throw Object.assign(new Error('bad credits shape'), { code: 'invalid-response' });
    }
    const remaining = credits - usage;
    return [{
      metric: 'balance:USD',
      observedAt: new Date().toISOString(),
      value: {
        kind: 'balance',
        currency: 'USD',
        total: dec(remaining) ?? '0',
        granted: dec(credits),
        purchased: null,
        available: remaining > 0,
      },
    }];
  },
};
