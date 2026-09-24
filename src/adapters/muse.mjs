import { omarchyAdapter } from './omarchy.mjs';

/**
 * Muse quota adapter — reads Omarchy's `muse` usage record.
 *
 * Omarchy probes POST https://api.meta.ai/muse-code/key on a system-wide
 * cadence and writes the limits to
 *   ~/.local/state/omarchy/agents/usage/muse.json
 * Reading that record means every pi session shares Omarchy's single probe
 * instead of each minting a request itself.
 *
 * The record's `limits` labels come from `window_duration_mins`: 300 →
 * "5h window", 10080 → "Weekly (7-day)", any other N hours → "<N>h window".
 * The short window is matched as /^\d+[hm] window$/i (not /^5h/) so a change
 * in window length still lands in the right slot. `percent` is a USED
 * fraction, mapped to remainingPercent by the reader.
 */

export const museAdapter = omarchyAdapter('muse', [
  { match: /^\d+[hm] window$/i, metric: 'quota:window', idleWhenAbsent: true },
  { match: /^weekly|^7-?day/i,  metric: 'quota:weekly' },
]);
