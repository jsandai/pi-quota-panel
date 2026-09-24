import { omarchyAdapter } from './omarchy.mjs';

/**
 * Antigravity (agy) quota adapter — reads Omarchy's `gemini` usage record.
 *
 * Omarchy probes the same endpoint the old adapter used
 * (POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary)
 * on a system-wide cadence and writes the limits to
 *   ~/.local/state/omarchy/agents/usage/gemini.json
 * The record's agent id is `gemini` — pi's provider id stays `antigravity`,
 * only the record file is named for the collector.
 *
 * The record's `limits` labels, in order:
 *   "5h window", "Weekly (7-day)", "Claude/GPT 5h", "Claude/GPT Weekly (7-day)"
 * The first two are the Gemini Models group; the Claude/GPT pair is the
 * separate third-party allowance. `percent` is a USED fraction, mapped to
 * remainingPercent by the reader.
 *
 * The matchers are anchored so the `Claude/GPT …` pair cannot satisfy the
 * plain Gemini slots — `omarchyAdapter` takes the first matching spec, so the
 * external pair must not match /^5h/ or /^weekly/.
 */

export const antigravityAdapter = omarchyAdapter('gemini', [
  { match: /^\d+[hm] window$/i,            metric: 'quota:5h', idleWhenAbsent: true },
  { match: /^weekly|^7-?day/i,             metric: 'quota:weekly' },
  { match: /^claude\/gpt \d+[hm]$/i,       metric: 'quota:external_5h', idleWhenAbsent: true },
  { match: /^claude\/gpt (weekly|7-?day)/i, metric: 'quota:external_weekly' },
]);
