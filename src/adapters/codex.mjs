import { omarchyAdapter } from './omarchy.mjs';

/**
 * Codex (ChatGPT) quota adapter — reads Omarchy's `codex` usage record.
 *
 * Omarchy gets Codex rate limits from the `codex app-server` RPC
 * (account/rateLimits/read) on a system-wide cadence and writes them to
 *   ~/.local/state/omarchy/agents/usage/codex.json
 * Reading that record means every pi session shares Omarchy's single probe
 * rather than each spawning the RPC or hitting ChatGPT's backend itself.
 *
 * The record's `limits` labels are "5h window" (primary) and "Weekly (7-day)"
 * (secondary). `percent` is a USED fraction, mapped to remainingPercent by the
 * reader.
 */

export const codexAdapter = omarchyAdapter('codex', [
  // Anchored to the general window labels the collector emits.
  { match: /^5h|^5-?hour|^primary/i,   metric: 'quota:5h', idleWhenAbsent: true },
  { match: /^weekly|^7-?day|^secondary/i, metric: 'quota:weekly' },
]);
