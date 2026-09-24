import { accountId } from './providers.mjs';

/**
 * @typedef {{capability:'quota'|'balance', credentialScope:string, parameters:any,
 *   metrics:string[]}} AdapterSpec
 * @typedef {{normalize:(config:any)=>AdapterSpec,
 *   run:(parameters:any, signal:AbortSignal)=>Promise<Array<{metric:string, value:any, observedAt:string, source?:string}>>}} Adapter
 * @typedef {{provider:string, account:string, metric:string}} ReadingIdentity
 * @typedef {{identity:ReadingIdentity, value:any|null, freshAt:string|null,
 *   attemptedAt:string, error:string|null, source?:string}} Reading
 */

/**
 * The poller. Runs every adapter for every configured provider and folds the
 * results into a readings map.
 *
 * This replaces a separate collector process, an abstract-socket transport with
 * mutual HMAC authentication, client leases and heartbeats, durable schedule
 * state, and a subprocess supervisor. None of that is needed to issue seven
 * bounded HTTP requests, and running in-process means a credential never leaves
 * this process at all.
 *
 * Two rules carried over from the previous design, because they are about being
 * honest rather than about plumbing:
 *
 *  - An absent measurement is never a number. A metric that fails with no
 *    last-good reading records the error and no value.
 *  - A failure never advances freshness. The last-good value is kept (so the row
 *    does not blank) but `freshAt` stays put, so it goes stale visibly.
 */

/** Per-request ceiling. Every adapter already bounds itself; this is the backstop. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Providers polled at once. */
export const MAX_CONCURRENCY = 4;

const FAILURE_CODES = new Set([
  'timeout', 'unauthorized', 'unavailable', 'invalid-response',
  'rate-limited', 'transport', 'unsupported',
]);

/** @param {{provider:string,account:string,metric:string}} identity */
export const readingKey = identity => `${identity.provider}\u0000${identity.account}\u0000${identity.metric}`;

/**
 * A genuine observation.
 * @param {any} identity @param {any} value @param {string} observedAt
 */
export function success(identity, value, observedAt, source) {
  return { identity, value, freshAt: observedAt, attemptedAt: observedAt, error: null, source };
}

/**
 * A failed attempt. `previous` supplies last-good, whose freshness is preserved.
 * @param {any} identity @param {any} previous @param {string} code @param {string} attemptedAt
 */
export function failure(identity, previous, code, attemptedAt) {
  return {
    identity,
    value: previous?.value ?? null,
    freshAt: previous?.freshAt ?? null,
    attemptedAt,
    error: FAILURE_CODES.has(code) ? code : 'invalid-response',
    // Keep the source tag so a failed refresh of an omarchy-backed reading does
    // not lose its longer stale window.
    ...(previous?.source ? { source: previous.source } : {}),
  };
}

/** Fold one job's observations into the readings map. */
function record(idBase, metrics, observations, readings, at) {
  const seen = new Set();
  for (const observation of observations ?? []) {
    if (!observation || !metrics.includes(observation.metric) || seen.has(observation.metric)) continue;
    seen.add(observation.metric);
    const identity = { ...idBase, metric: observation.metric };
    readings.set(readingKey(identity), success(identity, observation.value, observation.observedAt ?? at, observation.source));
  }
  // A metric the adapter did not report: if we held a value for it, losing it is
  // worth recording; if we never had one, it is simply absent and recording a
  // failure every cycle would put a permanent "invalid-response" on the account.
  // DeepSeek advertises a metric per currency but an account has only one, so
  // the missing one used to sit there as a fault forever.
  for (const metric of metrics) {
    if (seen.has(metric)) continue;
    const identity = { ...idBase, metric };
    const key = readingKey(identity);
    const prior = readings.get(key);
    if (prior?.value) readings.set(key, failure(identity, prior, 'invalid-response', at));
    else readings.delete(key);
  }
}

/**
 * Run one job with its own timeout, then record the outcome.
 * @returns {Promise<boolean>} true when the adapter produced at least one
 *   observation — the only outcome that proves the account is really there.
 */
async function runJob(job, readings, timeoutMs) {
  const controller = new AbortController();
  const at = new Date().toISOString();
  const idBase = { provider: job.provider, account: job.account };
  let timer;
  // The timeout must be RACED, not just signalled. An adapter that ignores its
  // abort signal (a wedged socket, or a bug) would otherwise hang this job
  // forever, and with it the whole cycle — the panel would simply stop
  // updating. Racing lets us abandon the job and move on.
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
    }, timeoutMs);
    // Node returns a Timeout (which has unref); DOM lib types it as number.
    // The optional call is intentional — it is a no-op where unref is absent.
    /** @type {any} */ (timer).unref?.();
  });
  try {
    const running = job.adapter.run(job.parameters, controller.signal);
    // An abandoned job may still settle later; make sure that is discarded
    // rather than surfacing as an unhandled rejection.
    running.catch(() => {});
    const observations = await Promise.race([running, expired]);
    record(idBase, job.metrics, observations, readings, at);
    return Array.isArray(observations) && observations.length > 0;
  } catch (error) {
    const code = FAILURE_CODES.has(/** @type {any} */ (error)?.code) ? /** @type {any} */ (error).code : 'transport';
    for (const metric of job.metrics) {
      const identity = { ...idBase, metric };
      const key = readingKey(identity);
      readings.set(key, failure(identity, readings.get(key), code, at));
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One poll cycle. Mutates and returns `readings`.
 *
 * @param {Array<{provider:string,adapter:string,config:any}>} requests
 * @param {{adapters:Map<string,any>, readings?:Map<string,any>, timeoutMs?:number,
 *   concurrency?:number, onReadings?:(readings:Map<string,any>)=>void}} options
 * @returns {Promise<Map<string,any>>}
 */
export async function pollOnce(requests, {
  adapters, readings = new Map(), timeoutMs = REQUEST_TIMEOUT_MS,
  concurrency = MAX_CONCURRENCY, onReadings,
}) {
  /** @type {Array<{provider:string,account:string,metrics:string[],parameters:any,adapter:any}>} */
  const jobs = [];
  for (const request of requests ?? []) {
    const adapter = adapters.get(request.adapter);
    if (!adapter) continue;
    let spec;
    // A malformed request is skipped, not thrown: one bad provider must not
    // stop the others from being read.
    try { spec = adapter.normalize(request.config); } catch { continue; }
    if (!spec) continue;
    jobs.push({
      provider: request.provider,
      account: accountId(spec.credentialScope),
      metrics: spec.metrics,
      parameters: spec.parameters,
      adapter,
    });
  }

  // Repaint as soon as the first provider lands, rather than waiting for the
  // slowest one.
  const notify = () => onReadings?.(readings);
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (await runJob(job, readings, timeoutMs)) succeeded.add(`${job.provider}\u0000${job.account}`);
      notify();
    }
  };
  const succeeded = new Set();
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));

  // Retire readings for accounts a cycle proves are gone. Proof is narrow: a
  // provider whose job this cycle produced at least one observation. Only then
  // are its OTHER accounts known-superseded (a rotated credential mints a new
  // identity; the old one can never resolve again). A provider that failed,
  // was skipped, or was never requested keeps every reading — an absent job
  // says nothing about its accounts, so dropping them would lose last-good
  // data on exactly the transient failures the stale marker exists to show.
  const refreshedProviders = new Set([...succeeded].map(k => k.split('\u0000')[0]));
  for (const key of [...readings.keys()]) {
    const identity = readings.get(key)?.identity;
    if (!identity || !refreshedProviders.has(identity.provider)) continue;
    if (!succeeded.has(`${identity.provider}\u0000${identity.account}`)) readings.delete(key);
  }

  notify();
  return readings;
}
