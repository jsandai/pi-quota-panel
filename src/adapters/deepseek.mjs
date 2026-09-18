import { fetchJson } from './http.mjs';

/**
 * DeepSeek balance adapter — GET https://api.deepseek.com/user/balance
 *
 * `balance_infos` entries carry `currency` (CNY/USD) and decimal-string
 * `total_balance` / `granted_balance` / `topped_up_balance`, plus
 * `is_available`. We preserve amounts as exact decimal strings and emit one
 * `balance:<CCY>` metric per entry. No inference, no other API calls.
 *
 * The API key arrives in `config.token`, resolved pi-side from the provider's
 * stored auth and passed over authenticated IPC.
 */

const BASE = 'https://api.deepseek.com';

/** @type {import('../poll.mjs').Adapter} */
export const deepseekAdapter = {
  /**
   * @param {{token?:string, baseUrl?:string}} config
   */
  normalize(config) {
    if (typeof config?.token !== 'string' || !config.token) throw new Error('Invalid deepseek request');
    return {
      capability: /** @type {'balance'} */ ('balance'),
      credentialScope: `deepseek:${config.token}`,
      parameters: { token: config.token, baseUrl: config.baseUrl },
      metrics: ['balance:CNY', 'balance:USD'],
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
    const { json } = await fetchJson(new URL('/user/balance', base + '/').toString(), {
      headers: { 'Authorization': `Bearer ${parameters.token}` },
      signal,
    });
    const infos = json?.balance_infos;
    if (!Array.isArray(infos)) throw Object.assign(new Error('no balance_infos'), { code: 'invalid-response' });
    const observedAt = new Date().toISOString();
    /** @type {Array<{metric:string, value:any, observedAt:string}>} */
    const out = [];
    for (const info of infos) {
      if (!info || typeof info.currency !== 'string' || !/^[A-Z]{3}$/.test(info.currency)) continue;
      const str = v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? v : null);
      out.push({
        metric: `balance:${info.currency}`,
        value: {
          kind: 'balance',
          currency: info.currency,
          total: str(info.total_balance) ?? '0',
          granted: str(info.granted_balance),
          purchased: str(info.topped_up_balance),
          available: typeof info.is_available === 'boolean' ? info.is_available : null,
        },
        observedAt,
      });
    }
    if (!out.length) throw Object.assign(new Error('no usable balance_infos'), { code: 'invalid-response' });
    return out;
  },
};
