import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fetchJson } from './http.mjs';

/**
 * Claude quota adapter.
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *
 * One ~0.3s request, no subprocess. `utilization` is USED percent, so
 * remaining = 100 - utilization.
 *
 * The credential is the Claude CLI's own OAuth token, read from
 * ~/.claude/.credentials.json at poll time so a refresh the CLI performs is
 * picked up without restarting. It does NOT come from pi: the claude-bridge
 * provider registers a literal placeholder apiKey, so getProviderAuth yields
 * nothing usable. This package never logs in and never writes that file.
 *
 * Fail closed: a missing or unreadable credential is reported as `unauthorized`
 * rather than invented.
 */

const DEFAULT_BASE = 'https://api.anthropic.com';

/** Resolve the Claude CLI credentials file. */
export function claudeCredentialsPath() {
  const override = process.env.CLAUDE_CREDENTIALS_PATH?.trim();
  return override || join(homedir(), '.claude', '.credentials.json');
}

/** Read the OAuth access token, or null. */
async function readToken(path) {
  try {
    const d = JSON.parse(await readFile(path, 'utf8'));
    const t = d?.claudeAiOauth?.accessToken;
    return typeof t === 'string' && t ? t : null;
  } catch {
    return null;
  }
}

/** Utilization (used %) -> remaining percent in [0,100]. */
const remaining = used => Math.max(0, Math.min(100, 100 - used));
const iso = v => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/** @type {import('../poll.mjs').Adapter} */
export const claudeAdapter = {
  /**
   * The credentialScope is the credentials file path so the account identity is
   * stable across token rotations.
   * @param {{credentialsFile?:string, baseUrl?:string}} config
   */
  normalize(config) {
    return {
      capability: /** @type {'quota'} */ ('quota'),
      credentialScope: `claude:${config?.credentialsFile ?? claudeCredentialsPath()}`,
      parameters: {
        credentialsFile: config?.credentialsFile ?? claudeCredentialsPath(),
        baseUrl: config?.baseUrl,
      },
      metrics: ['quota:session', 'quota:week'],
    };
  },
  /**
   * @param {{credentialsFile?:string, baseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const observedAt = new Date().toISOString();
    const token = await readToken(parameters.credentialsFile ?? claudeCredentialsPath());
    if (!token) throw Object.assign(new Error('no claude credential'), { code: 'unauthorized' });
    const base = (parameters.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    const { json } = await fetchJson(new URL('/api/oauth/usage', base + '/').toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Accept': 'application/json',
      },
      signal,
    });
    const out = [];
    if (json?.five_hour && typeof json.five_hour.utilization === 'number') {
      out.push({ metric: 'quota:session', observedAt, value: {
        kind: 'quota', remainingPercent: remaining(json.five_hour.utilization),
        resetAt: iso(json.five_hour.resets_at), durationMinutes: null } });
    }
    if (json?.seven_day && typeof json.seven_day.utilization === 'number') {
      out.push({ metric: 'quota:week', observedAt, value: {
        kind: 'quota', remainingPercent: remaining(json.seven_day.utilization),
        resetAt: iso(json.seven_day.resets_at), durationMinutes: null } });
    }
    if (!out.length) throw Object.assign(new Error('no claude usage windows'), { code: 'invalid-response' });
    return out;
  },
};
