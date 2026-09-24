/**
 * Pure presentation layer. No I/O, no pi imports, no theme dependency — every
 * function takes plain data and returns plain strings so it is fully testable
 * offline and reusable from both the TUI component and the string-array
 * fallback. Colour is applied by the caller via a `paint(severity, text)` hook.
 *
 * Layout contract (mirrors the live quota-panel.ts it replaces):
 *  - A FIXED row order with short labels, two cells per line:
 *      D1 | D2        Claude | Codex      AGY | Ext       Muse | DS | OR
 *    (the last line carries three cells: Muse quota, then the two credit
 *    balances, so the subscription and the two pay-as-you-go balances sit
 *    together on the bottom row.)
 *  - Reset times shown by default: "HH:MM" today, "M/D HH:MM" otherwise.
 *  - Every cell is the same width whatever it holds, so a percentage going
 *    100 -> 0 or a reset going absolute -> relative never reflows the grid.
 *  - The active marker (▸) and stale marker (⚠) occupy reserved slots rather
 *    than sitting inline, so switching provider or a probe dying never shifts
 *    the numbers.
 *  - Narrow terminals drop to a single column instead of truncating a cell.
 *  - Stale readings keep their last-good value but are marked; a failed metric
 *    with no last-good shows its error code, never a fake zero.
 */

/** @param {string} s @param {number} n */
const pad = (s, n) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
/** @param {string} s @param {number} n */
const padLeft = (s, n) => (s.length >= n ? s.slice(-n) : ' '.repeat(n - s.length) + s);

const LABEL_W = 7;
const PCT_W = 4;
const RESET_W = 12;      // holds "↻12/25 08:25"
/** One quota window block: " 5H " + pct + " " + reset. The credits cell reuses
 *  this width so its two pairs line up under 5H and 7D respectively. */
const WINDOW_BLOCK_W = 4 + PCT_W + 1 + RESET_W;
const CREDIT_CODE_W = 2;
const CREDIT_AMOUNT_W = 9;   // fits "$1234.56" and stays put as digits change
const CREDIT_TAG_W = 1 + CREDIT_CODE_W + 1;   // " DS "
const GUTTER = '    ';
const COLUMNS = 2;
const DESKTOP_MIN_WIDTH = 108;

/** Severity buckets shared with the live panel so colours never disagree. */
export function severity(pct) {
  if (pct === null || pct === undefined) return 'dim';
  if (pct < 10) return 'error';
  if (pct < 30) return 'warning';
  return 'success';
}

/**
 * "HH:MM" when the reset is today, "M/D HH:MM" otherwise — the date makes a
 * reset 23h out unambiguous. Returns '' for an absent/unparseable instant.
 * @param {string|null} resetAt @param {number} [now]
 */
export function formatReset(resetAt, now = Date.now()) {
  if (!resetAt) return '';
  const at = new Date(resetAt);
  if (Number.isNaN(at.getTime())) return '';
  const base = new Date(now);
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const sameDay = at.getFullYear() === base.getFullYear() && at.getMonth() === base.getMonth() && at.getDate() === base.getDate();
  return sameDay ? hhmm : `${at.getMonth() + 1}/${at.getDate()} ${hhmm}`;
}

/**
 * The fixed display order. Each spec names the row label and how to find its
 * data among the readings:
 *  - `provider` (+ `altProviders`) selects which provider's readings the row
 *    shows; `accountIndex` picks among that provider's accounts, so two accounts
 *    of one provider occupy separate rows.
 *  - `external: true` reads the provider's `quota:external_*` metrics instead
 *    of its primary windows (the AGY "Ext" row).
 *  - `creditProviders` renders one prepaid balance per listed provider, in a
 *    single cell.
 *
 * Order is also the layout: cells fill left-to-right, two per line. The two
 * Devin accounts lead so they sit side by side — same product, two accounts,
 * the comparison you actually make. Muse and the credits land on the last row.
 */
/**
 * @typedef {{key:string, label:string, provider?:string, altProviders?:string[],
 *   accountIndex?:number, external?:boolean,
 *   creditProviders?:Array<{provider:string, code:string}>}} RowSpec
 */

/** Provider ids that are Devin accounts. */
const DEVIN_FAMILY = /^devin(-|$)/;

/**
 * The display order for the providers actually present.
 *
 * Mostly fixed, but the Devin rows are generated: an extension that exposes one
 * provider per account ids them from its own config, so those arrive as separate
 * provider ids (`devin`, `devin-alt`, …) rather than as several accounts of one.
 * One row each, in a stable order, keeps both accounts visible and works for
 * however many are configured.
 *
 * @param {Set<string>} providerIds
 * @returns {RowSpec[]}
 */
function rowSpecs(providerIds) {
  const devins = [...providerIds].filter(p => DEVIN_FAMILY.test(p))
    .sort((a, b) => (a === 'devin' ? -1 : b === 'devin' ? 1 : a.localeCompare(b)));
  return [
    ...devins.map((provider, i) => ({ key: `devin${i}`, label: `D${i + 1}`, provider })),
    { key: 'claude', label: 'Claude', provider: 'claude-bridge', altProviders: ['anthropic'] },
    { key: 'codex', label: 'Codex', provider: 'openai-codex' },
    { key: 'gemini', label: 'AGY', provider: 'antigravity' },
    { key: 'gemini:external', label: 'Ext', provider: 'antigravity', external: true },
    { key: 'muse', label: 'Muse', provider: 'meta', altProviders: ['muse-code'] },
    // The two pay-as-you-go balances share ONE cell so the grid stays a regular
    // two-per-line block: combining them keeps the last row at two cells
    // (Muse | Credits) instead of three, which is what made the split look
    // lopsided. Each entry is a provider plus the short code shown for it.
    { key: 'credits', label: 'Credits', creditProviders: [
      { provider: 'deepseek', code: 'DS' },
      { provider: 'openrouter', code: 'OR' },
    ] },
  ];
}

/** Currency code -> symbol, for a compact money cell. Unknown codes fall back
 *  to the code itself, so a non-USD balance still reads unambiguously. */
const CURRENCY_SYMBOL = { USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥' };

/** metric name -> which window slot it fills. */
const FIVE_METRICS = ['quota:5h', 'quota:session', 'quota:window'];
const SEVEN_METRICS = ['quota:7d', 'quota:week', 'quota:weekly'];
const EXT_FIVE = ['quota:external_5h'];
const EXT_SEVEN = ['quota:external_weekly'];

/**
 * Group readings into display cells following ROW_SPECS, in spec order. A cell
 * appears only if some reading (or account) matches it, so a provider that is
 * not configured simply has no row.
 * @param {Array<import('./poll.mjs').Reading>} readings
 * @param {Array<{provider:string,account:string,capability:string,metrics:string[]}>} [mappings]
 *   account ordering, when a caller has one; readings alone are sufficient.
 * @param {{now?:number, staleMs?:number, omarchyStaleMs?:number}} [options]
 */
export function groupRows(readings, mappings, { now = Date.now(), staleMs = 15 * 60_000, omarchyStaleMs = 35 * 60_000 } = {}) {
  // Index readings by provider -> account -> {quota:Map, balances:[], stale, error}
  /** @type {Map<string, Map<string, {quota:Map<string,any>, balances:any[], stale:boolean, error:string|null}>>} */
  const byProvider = new Map();
  const accountOrder = new Map();   // provider -> [account,...] in mapping order
  const ensure = (provider, account) => {
    if (!byProvider.has(provider)) byProvider.set(provider, new Map());
    const m = /** @type {Map<string,{quota:Map<string,any>,balances:any[],stale:boolean,error:string|null}>} */ (byProvider.get(provider));
    if (!m.has(account)) m.set(account, { quota: new Map(), balances: [], stale: false, error: null });
    return /** @type {{quota:Map<string,any>,balances:any[],stale:boolean,error:string|null}} */ (m.get(account));
  };
  for (const mapping of mappings ?? []) {
    ensure(mapping.provider, mapping.account);
    if (!accountOrder.has(mapping.provider)) accountOrder.set(mapping.provider, []);
    const list = accountOrder.get(mapping.provider);
    if (!list.includes(mapping.account)) list.push(mapping.account);
  }
  for (const reading of readings ?? []) {
    const { provider, account, metric } = reading.identity;
    const slot = ensure(provider, account);
    if (!accountOrder.has(provider)) accountOrder.set(provider, []);
    const list = accountOrder.get(provider);
    if (!list.includes(account)) list.push(account);
    const s = /** @type {{quota:Map<string,any>,balances:any[],stale:boolean,error:string|null}} */ (slot);
    // Staleness means "we have a value and it is old". A metric that has never
    // once produced a value has no freshness to be stale about — treating a null
    // freshAt as infinitely old marked whole accounts stale forever whenever a
    // provider declared a metric it never returned (DeepSeek advertises CNY and
    // USD, but a given account has only one of them).
    // Omarchy-routed readings age on the collector's ~900s cadence, which sits
    // right at the default stale limit — they'd flicker ⚠ just before each
    // refresh. Give them a window that outlasts one collector interval.
    const limit = reading.source === 'omarchy' ? omarchyStaleMs : staleMs;
    if (reading.freshAt && now - Date.parse(reading.freshAt) > limit) s.stale = true;
    if (reading.error && !reading.value) s.error = reading.error;
    if (reading.value?.kind === 'balance') s.balances.push(reading);
    else s.quota.set(metric, reading);
  }

  const cells = [];
  for (const spec of rowSpecs(new Set(byProvider.keys()))) {
    // A credits cell aggregates one balance reading set per listed provider.
    if (spec.creditProviders) {
      /** @type {Map<string, any[]>} */
      const balancesByProvider = new Map();
      let stale = false, error = null, any = false;
      for (const { provider } of spec.creditProviders) {
        const accounts = accountOrder.get(provider) ?? [...(byProvider.get(provider)?.keys() ?? [])];
        const slot = accounts.length ? byProvider.get(provider)?.get(accounts[0]) : null;
        if (!slot) { balancesByProvider.set(provider, []); continue; }
        any = true;
        balancesByProvider.set(provider, slot.balances);
        if (slot.stale) stale = true;
        if (slot.error) error = slot.error;
      }
      if (!any) continue;   // neither provider present: drop the cell
      cells.push({ spec, provider: spec.key, account: 'credits', quota: new Map(),
        balances: [], balancesByProvider, stale, error });
      continue;
    }
    // Every spec reaching here names a provider: the credits spec returned above.
    const primary = /** @type {string} */ (spec.provider);
    const providers = [primary, ...(spec.altProviders ?? [])];
    // Find the account bucket for this spec across its candidate providers.
    let slot = null, provider = primary, account = '';
    for (const p of providers) {
      const accounts = accountOrder.get(p) ?? [...(byProvider.get(p)?.keys() ?? [])];
      const idx = spec.accountIndex ?? 0;
      if (accounts.length > idx) {
        account = accounts[idx];
        slot = byProvider.get(p)?.get(account) ?? null;
        provider = p;
        break;
      }
      // A provider may exist in readings but not in mappings (no account list);
      // fall back to its first known account.
      const m = byProvider.get(p);
      if (m && m.size > idx) {
        const acc = [...m.keys()][idx];
        account = acc;
        slot = m.get(acc) ?? null;
        provider = p;
        break;
      }
    }
    if (!slot) continue;   // no data for this spec: drop the cell
    cells.push({ spec, provider, account, ...slot });
  }
  return cells;
}

/** Pick a window reading from a quota map by candidate metric names. */
function pickWindow(quota, names) {
  for (const n of names) if (quota.has(n)) return quota.get(n);
  return null;
}

/**
 * Render one cell to unstyled text with severity-tagged spans. Returns
 * {text, spans}; spans mark [start,end) severity ranges the caller colours.
 * @param {ReturnType<typeof groupRows>[number]} cell
 * @param {{now?:number, showResets?:boolean, activeProvider?:string|null}} [options]
 */
export function renderRow(cell, { now = Date.now(), showResets = true, activeProvider = null } = {}) {
  const spans = [];
  let text = '';
  const push = (segment, level) => {
    if (level) spans.push([text.length, text.length + segment.length, level]);
    text += segment;
  };
  const spec = cell.spec;
  const isActive = activeProvider && [spec.provider, ...(spec.altProviders ?? [])].includes(activeProvider);

  // Reserved slots: active marker, label.
  push(isActive ? '▸' : ' ', isActive ? 'accent' : null);
  push(' ', null);
  push(pad(spec.label, LABEL_W), isActive ? 'accent' : 'muted');

  if (spec.creditProviders) {
    // Combined ledger cell. Each pair occupies exactly one quota WINDOW_BLOCK_W
    // so `DS` starts in the same column as `5H` and `OR` as `7D`; the cell is
    // therefore the same width as a quota cell and the columns all line up.
    const pairPad = WINDOW_BLOCK_W - (CREDIT_TAG_W + CREDIT_AMOUNT_W);
    spec.creditProviders.forEach(({ provider, code }, index) => {
      if (index > 0) push(' ', null);   // separator, mirroring the window gap
      push(` ${pad(code, CREDIT_CODE_W)} `, 'dim');
      // A provider can have several balance readings (DeepSeek reports one per
      // currency) and one of them may be a failure with no value. Take the first
      // that actually has a balance, so a failed currency cannot hide a good one.
      const all = cell.balancesByProvider?.get(provider) ?? [];
      const bal = all.find((r) => r?.value) ?? all[0] ?? null;
      if (bal?.value) {
        const sym = CURRENCY_SYMBOL[bal.value.currency] ?? bal.value.currency;
        // Negative balances keep the sign inside the value, not the padding.
        push(padLeft(`${sym}${bal.value.total ?? '—'}`, CREDIT_AMOUNT_W),
          bal.value.available === false ? 'warning' : 'success');
      } else {
        push(padLeft(bal?.error ? 'err' : '—', CREDIT_AMOUNT_W), bal?.error ? 'error' : 'dim');
      }
      push(' '.repeat(pairPad), null);
    });
  } else {
    const fiveNames = spec.external ? EXT_FIVE : FIVE_METRICS;
    const sevenNames = spec.external ? EXT_SEVEN : SEVEN_METRICS;
    const five = pickWindow(cell.quota, fiveNames);
    const seven = pickWindow(cell.quota, sevenNames);
    const win = (tag, rd) => {
      if (!rd) { push(` ${tag} ${padLeft('—', PCT_W)}`, 'dim'); push(' ' + pad('', RESET_W), null); return; }
      push(` ${tag} `, 'dim');
      if (rd.value?.kind === 'quota') {
        push(padLeft(`${Math.round(rd.value.remainingPercent)}%`, PCT_W), severity(rd.value.remainingPercent));
      } else {
        push(padLeft(rd.error ? 'err' : '—', PCT_W), rd.error ? 'error' : 'dim');
      }
      if (showResets) {
        const reset = rd.value?.resetAt ? `↻${formatReset(rd.value.resetAt, now)}` : '';
        push(' ' + pad(reset, RESET_W), 'dim');
      } else {
        push(' ' + pad('', RESET_W), null);
      }
    };
    win('5H', five);
    push(' ', null);
    win('7D', seven);
  }
  // Reserved stale slot at the end.
  push(' ', null);
  push(cell.stale ? '⚠' : ' ', cell.stale ? 'warning' : null);
  return { text, spans };
}

/**
 * Lay out cells into lines that fit `width`. Wide terminals pack two cells per
 * line in the fixed ROW_SPECS order; narrow terminals drop to one column.
 * @param {Array<ReturnType<typeof groupRows>[number]>} cells
 * @param {{width?:number, now?:number, showResets?:boolean, activeProvider?:string|null}} [options]
 * @returns {Array<{text:string, spans:Array<[number,number,string]>}>}
 */
export function layout(cells, { width = 0, now = Date.now(), showResets = true, activeProvider = null } = {}) {
  const rendered = cells.map(c => renderRow(c, { now, showResets, activeProvider }));
  if (!rendered.length) return [{ text: '  usage: no data', spans: [[0, 15, 'dim']] }];
  const cols = width > 0 && width < DESKTOP_MIN_WIDTH ? 1 : COLUMNS;
  // Group cells into display lines. The quota rows pair two-per-line; the two
  // credit cells (DS, OR) join Muse on the final line so all three balances
  // sit together on the bottom row.
  // Two per line. The credits cell is an ordinary cell now (one cell holding
  // both balances), so it needs no special case: eight cells pair into four
  // lines with Muse | Credits last.
  const lines = [];
  const pushLine = (group) => {
    const text = group.map(c => c.text).join(GUTTER);
    /** @type {Array<[number,number,string]>} */
    const spans = [];
    let offset = 0;
    for (const cell of group) {
      for (const [s, e, l] of cell.spans) spans.push([s + offset, e + offset, l]);
      offset += cell.text.length + GUTTER.length;
    }
    lines.push({ text, spans });
  };
  if (cols === 1) {
    for (const c of rendered) pushLine([c]);
  } else {
    for (let i = 0; i < rendered.length; i += COLUMNS) pushLine(rendered.slice(i, i + COLUMNS));
  }
  return lines;
}
