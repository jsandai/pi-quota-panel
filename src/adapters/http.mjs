/**
 * Shared bounded HTTP helper for provider adapters.
 *
 * Rules every adapter inherits:
 *  - One request, one timeout, one response-size cap. No retries inside the
 *    helper; the scheduler owns cadence and backoff.
 *  - Credentials are attached ONLY to the caller-supplied origin. Redirects are
 *    never followed, so a Bearer token can never be forwarded to a third party.
 *  - `Accept-Encoding: identity` is forced: we do not ship a brotli/zstd
 *    decoder, and identity keeps the response dependency-free and honest.
 *  - Response bodies are capped and parsed as JSON; anything else is a
 *    sanitized `invalid-response`/`transport`/`unauthorized` error, never the
 *    raw body or header text (which can echo a credential).
 */

export const MAX_BODY_BYTES = 256 * 1024;

/** @param {string} code @returns {Error & {code:string}} */
function httpError(code) {
  const error = /** @type {any} */ (new Error(code));
  error.code = code;
  return error;
}

/**
 * @param {string} url
 * @param {{method?:string, headers?:Record<string,string>, body?:string|Uint8Array,
 *   timeoutMs?:number, signal?:AbortSignal}} options
 * @returns {Promise<{status:number, json:any}>}
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15_000, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw httpError('invalid-response');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(httpError('timeout')), timeoutMs);
  timer.unref();
  const onAbort = () => controller.abort(signal?.reason instanceof Error ? signal.reason : httpError('timeout'));
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw httpError('timeout'); }
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Accept-Encoding': 'identity', ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : new Uint8Array(body)),
      redirect: 'manual',          // never follow; a redirect could carry credentials off-origin
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) throw httpError('unauthorized');
    if (response.status === 429) throw httpError('rate-limited');
    if (response.status >= 500) throw httpError('unavailable');
    if (response.status < 200 || response.status >= 300) throw httpError('transport');
    const text = await readCapped(response);
    try {
      return { status: response.status, json: JSON.parse(text) };
    } catch { throw httpError('invalid-response'); }
  } catch (error) {
    if (/** @type {any} */ (error)?.code) throw error;  // already sanitized
    if (controller.signal.aborted) throw httpError('timeout');
    throw httpError('transport');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** @param {Response} response */
async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) { await reader.cancel(); throw httpError('invalid-response'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}
