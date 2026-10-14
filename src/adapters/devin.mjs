/**
 * Devin quota adapter — Connect RPC GetUserStatus, no TUI.
 *
 * The interactive `devin` banner (and `devin auth status`) reads quota from:
 *   POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus
 * with a Connect unary protobuf body and `Authorization: Basic <key>-<key>`.
 * We call it directly, so quota costs one ~0.3s request instead of spawning the
 * TUI, waiting ~4s for the banner, and killing it.
 *
 * The key arrives as `config.token`, resolved from pi. That covers every Devin
 * account pi has configured, because the extension that provides the provider
 * resolves each account's key for that provider id — so a second account shows
 * up on its own, with no extra configuration here.
 *
 * Request body (protobuf): field 1 = client metadata {1:name, 2:version,
 *   3:<key>, 4:locale, 5:platform, 7:version, 12:name}. The server accepts it
 *   without the optional device-fingerprint field.
 *
 * Response path to quota (GetUserStatusResponse -> user_status -> plan_status):
 *   field 14 = daily_quota_remaining_percent   (absent = 0)
 *   field 15 = weekly_quota_remaining_percent  (absent = 0)
 *   field 17 = daily_quota_reset_at_unix
 *   field 18 = weekly_quota_reset_at_unix
 * We emit `quota:weekly`, matching the banner's "N% remaining (resets in …)", and
 * `quota:daily` (shown as the panel's 1D slot). A missing percent is 0 (proto3 drops
 * zeros), but a daily window with neither percent nor reset isn't there at all, so
 * no `quota:daily` is emitted rather than a false 0%.
 */

const DEFAULT_BASE = 'https://server.codeium.com';
const METHOD = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';

/* ---- minimal protobuf (length-delimited fields only) ---------------- */

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return Buffer.from(out);
}

function field(num, data) {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([varint((num << 3) | 2), varint(body.length), body]);
}

function readVarint(buf, i) {
  let n = 0, shift = 0;
  for (;;) {
    const b = buf[i++];
    n += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [n, i];
}

/** Parse a protobuf message into [{f, type, value}] (varint / bytes / f32 / f64). */
function parseMessage(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = readVarint(buf, i);
    const f = tag >> 3, wt = tag & 7;
    if (wt === 0) { let v; [v, i] = readVarint(buf, i); out.push({ f, type: 'varint', value: v }); }
    else if (wt === 2) { let ln; [ln, i] = readVarint(buf, i); out.push({ f, type: 'bytes', value: buf.subarray(i, i + ln) }); i += ln; }
    else if (wt === 5) { out.push({ f, type: 'f32', value: buf.readFloatLE(i) }); i += 4; }
    else if (wt === 1) { out.push({ f, type: 'f64', value: buf.readDoubleLE(i) }); i += 8; }
    else break;
  }
  return out;
}

const firstBytes = (msg, num) => msg.find(x => x.f === num && x.type === 'bytes')?.value ?? null;
const numOf = (msg, num) => msg.find(x => x.f === num && x.type === 'varint')?.value;

/** Build the GetUserStatus request body for a key. */
function requestBody(key) {
  const meta = Buffer.concat([
    field(1, 'chisel'), field(2, '0.0.0-dev'), field(3, key),
    field(4, 'en'), field(5, 'linux'), field(7, '0.0.0-dev'), field(12, 'chisel'),
  ]);
  return field(1, meta);
}

/** @type {import('../poll.mjs').Adapter} */
export const devinAdapter = {
  /**
   * @param {{token?:string, baseUrl?:string}} config
   */
  normalize(config) {
    if (typeof config?.token !== 'string' || !config.token) throw new Error('Invalid devin request');
    return {
      capability: /** @type {'quota'} */ ('quota'),
      credentialScope: `devin:${config.token}`,
      parameters: { token: config.token, baseUrl: config.baseUrl },
      metrics: ['quota:daily', 'quota:weekly'],
    };
  },
  /**
   * @param {{token:string, baseUrl?:string}} parameters
   * @param {AbortSignal} signal
   */
  async run(parameters, signal) {
    const key = parameters.token;
    const base = (parameters.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    let url;
    try { url = new URL(base); } catch { throw Object.assign(new Error('bad base'), { code: 'invalid-response' }); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      throw Object.assign(new Error('insecure base'), { code: 'invalid-response' });
    }

    let response;
    try {
      response = await fetch(new URL(METHOD, base + '/').toString(), {
        method: 'POST',
        headers: {
          // Not base64: the server takes the key duplicated around a '-'.
          'Authorization': `Basic ${key}-${key}`,
          'Content-Type': 'application/proto',
          'Connect-Protocol-Version': '1',
        },
        body: new Uint8Array(requestBody(key)),
        redirect: 'manual',
        signal,
      });
    } catch {
      throw Object.assign(new Error('devin transport'), { code: 'transport' });
    }
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
    if (response.status >= 500) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('transport'), { code: 'transport' });
    const buf = Buffer.from(await response.arrayBuffer());

    // Walk GetUserStatusResponse -> user_status(f1) -> plan_status(f13).
    const top = parseMessage(buf);
    const userStatus = firstBytes(top, 1);
    if (!userStatus) throw Object.assign(new Error('no user_status'), { code: 'invalid-response' });
    const planStatus = firstBytes(parseMessage(userStatus), 13);
    if (!planStatus) throw Object.assign(new Error('no plan_status'), { code: 'invalid-response' });
    const ps = parseMessage(planStatus);

    const observedAt = new Date().toISOString();
    const window = (metric, pctField, resetField, durationMinutes) => {
      const reset = numOf(ps, resetField);
      return {
        metric,
        observedAt,
        value: {
          kind: 'quota',
          remainingPercent: Math.max(0, Math.min(100, numOf(ps, pctField) ?? 0)),   // absent = 0
          resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
          durationMinutes,
        },
      };
    };
    const out = [];
    if (numOf(ps, 14) !== undefined || numOf(ps, 17) !== undefined) out.push(window('quota:daily', 14, 17, 24 * 60));
    out.push(window('quota:weekly', 15, 18, 7 * 24 * 60));
    return out;
  },
};
