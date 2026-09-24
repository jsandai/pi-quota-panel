import { omarchyAdapter } from './omarchy.mjs';

/**
 * Claude quota adapter — reads Omarchy's `claude` usage record.
 *
 * Omarchy polls https://api.anthropic.com/api/oauth/usage on a system-wide
 * cadence and writes the result to
 *   ~/.local/state/omarchy/agents/usage/claude.json
 * Reading that record means every pi session shares Omarchy's single probe
 * instead of each hitting the endpoint itself — the per-process polling that
 * used to run here is what got the direct probe rate-limited (HTTP 429).
 *
 * The record's `limits` labels are "Session (5-hour)" and "Weekly (7-day)";
 * model-scoped extras like "Fable Weekly" match no window and are ignored.
 * `percent` is a USED fraction, mapped to remainingPercent by the reader.
 */

export const claudeAdapter = omarchyAdapter('claude', [
  // Anchored to the general window labels so a model-scoped extra like
  // "Fable Weekly" cannot satisfy the weekly slot.
  // The 5h session window is absent from the record while idle (Omarchy drops
  // a limit once its resetsAt passes), so report it 100% rather than stale.
  { match: /^session|^5-?hour|^5h/i, metric: 'quota:session', idleWhenAbsent: true },
  { match: /^weekly|^7-?day/i,       metric: 'quota:week' },
]);
