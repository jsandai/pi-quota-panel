import { createHash } from 'node:crypto';

/**
 * Provider discovery and credential resolution — the pi-side half of the panel.
 *
 * This runs in the pi process and hands finished parameters to an adapter in the
 * same process, so a credential never crosses a process or socket boundary and
 * is never written to disk. Only a hash of it is persisted, as the account id.
 *
 * Which providers exist is pi's business, not ours: we ask the model registry.
 * pi derives availability from the configured-auth snapshot, so a provider with
 * a usable credential and at least one model shows up here.
 */

/**
 * Stable, non-secret account id for a credential scope. The scope may embed a
 * raw token (adapter-defined), so it is hashed before it can end up in a
 * reading — a cache file must never carry credential material.
 * @param {string} scope
 */
export function accountId(scope) {
  return createHash('sha256').update(String(scope)).digest('hex').slice(0, 16);
}

/**
 * Which adapter serves a provider, and where its credential comes from.
 *
 *   'pi'       resolved from pi's credential store (getProviderAuth)
 *   'cliFile'  the adapter reads the provider CLI's own file at poll time
 *   'omarchy'  the adapter reads Omarchy's per-agent usage record; no
 *              credential is resolved at all
 *
 * `match` is a pattern rather than a fixed name where the provider id is
 * user-chosen: an extension registering one provider per account ids them from
 * its own config, so `devin`, `devin-alt` and anything else a user names must
 * all resolve to the same adapter.
 */
const ROUTES = [
  { match: /^devin(-|$)/, adapter: 'devin', credential: 'pi' },
  { match: /^openai-codex$/, adapter: 'codex', credential: 'omarchy' },
  { match: /^deepseek$/, adapter: 'deepseek', credential: 'pi' },
  { match: /^openrouter$/, adapter: 'openrouter', credential: 'pi' },
  { match: /^(meta|muse-code)$/, adapter: 'muse', credential: 'omarchy' },
  { match: /^(anthropic|claude-bridge)$/, adapter: 'claude', credential: 'omarchy' },
  { match: /^antigravity$/, adapter: 'antigravity', credential: 'omarchy' },
];

/** @param {string} provider */
export function routeFor(provider) {
  return ROUTES.find(r => r.match.test(provider)) ?? null;
}

/** Pull a token out of a resolved auth result, whichever shape it uses. */
function tokenFrom(auth) {
  const key = auth?.auth?.apiKey;
  if (typeof key === 'string' && key) return key;
  const header = auth?.auth?.headers?.Authorization ?? auth?.auth?.headers?.authorization;
  return typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : undefined;
}

/**
 * Turn the registry into a list of adapter requests.
 *
 * @param {any} registry pi's `ctx.modelRegistry`
 * @param {{resolveAuth?:(provider:string)=>Promise<any>}} [options] injectable for tests
 * @returns {Promise<{configuredProviders:string[], requests:Array<{provider:string,adapter:string,config:any}>, dropped:Array<{provider:string,reason:string}>}>}
 */
export async function buildRequests(registry, { resolveAuth } = {}) {
  // getAvailable() is the supported enumeration: getRegisteredProviderIds()
  // returns only extension-registered providers and omits every built-in.
  const models = registry.getAvailable?.() ?? registry.getAll?.() ?? [];
  const configuredProviders = [...new Set(models.map(m => m?.provider).filter(p => typeof p === 'string'))];
  const resolve = resolveAuth ?? (p => registry.getProviderAuth(p));
  /** @type {Array<{provider:string,adapter:string,config:any}>} */
  const requests = [];
  /** @type {Array<{provider:string,reason:string}>} */
  const dropped = [];

  for (const provider of configuredProviders) {
    const route = routeFor(provider);
    if (!route) { dropped.push({ provider, reason: 'no-route' }); continue; }
    const status = registry.getProviderAuthStatus?.(provider);
    if (status && status.configured === false) { dropped.push({ provider, reason: 'unconfigured' }); continue; }

    /** @type {any} */
    const config = {};
    if (route.credential === 'pi') {
      const auth = await resolve(provider).catch(() => undefined);
      const token = tokenFrom(auth);
      if (!token) { dropped.push({ provider, reason: 'no-credential' }); continue; }
      config.token = token;
    }
    // 'cliFile' and 'omarchy' need nothing: the adapter reads its
    // own source at poll time, so a refresh performed by that CLI (or Omarchy)
    // is picked up automatically.
    requests.push({ provider, adapter: route.adapter, config });
  }

  return { configuredProviders, requests, dropped };
}
