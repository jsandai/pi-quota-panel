import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Hive credit-balance adapter — file tap, same contract as omarchy.mjs.
 *
 * Hive's balance endpoint (portal-customer-api.thehive.ai) is gated by a
 * dashboard session cookie that Chromium 152 app-bound-encrypts, so no
 * credential pi holds can reach it. A separate CDP poller inside the live
 * browser writes $XDG_STATE_HOME/hive-balance/<account>.json:
 *   { "balance": "105.0776", "currency": "USD", "observedAt": "..." }
 * We read that file; a missing/malformed record is unavailable, never a number.
 */

/** @param {string} account */
export function hiveBalancePath(account) {
  const state = process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(state, 'hive-balance', `${account}.json`);
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Build an adapter that reads one account's balance record.
 * @param {string} account
 * @returns {import('../poll.mjs').Adapter}
 */
function makeAdapter(account) {
  return {
    normalize() {
      return {
        capability: 'balance',
        credentialScope: `hive:${account}`,
        parameters: { account },
        metrics: ['balance:USD'],
      };
    },
    async run(parameters) {
      let d = null;
      try { d = JSON.parse(await readFile(hiveBalancePath(parameters.account), 'utf8')); } catch { /* absent */ }
      if (!d || typeof d !== 'object')
        throw Object.assign(new Error('no hive balance record'), { code: 'unavailable' });
      const balance = typeof d.balance === 'string' && DECIMAL.test(d.balance) ? d.balance : null;
      if (balance === null)
        throw Object.assign(new Error('malformed hive balance record'), { code: 'invalid-response' });
      // The portal reports 10 decimal places; the cell fits 9 chars. Round to
      // cents here so the renderer never truncates a raw balance string.
      const rounded = Number(balance).toFixed(2);
      const observedAt = d.observedAt && !Number.isNaN(Date.parse(d.observedAt))
        ? new Date(d.observedAt).toISOString() : new Date().toISOString();
      return [{
        metric: 'balance:USD',
        value: { kind: 'balance', currency: 'USD', total: rounded, granted: null, purchased: null, available: true },
        observedAt,
        source: 'hive-cdp',
      }];
    },
  };
}

export const hiveAdapter = makeAdapter('h1');
export const hiveAltAdapter = makeAdapter('h2');
