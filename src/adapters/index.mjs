import { codexAdapter } from './codex.mjs';
import { devinAdapter } from './devin.mjs';
import { claudeAdapter } from './claude.mjs';
import { antigravityAdapter } from './antigravity.mjs';
import { museAdapter } from './muse.mjs';
import { deepseekAdapter } from './deepseek.mjs';
import { openrouterAdapter } from './openrouter.mjs';

/**
 * Adapter registry. Most adapters read their provider over HTTP; the
 * Omarchy-routed ones (claude, codex, muse) read a local record file instead.
 * Every adapter declares a fixed shape in `normalize`, so a caller never
 * supplies a shell command, a URL or a file path of its own choosing.
 *
 * @type {Map<string, import('../poll.mjs').Adapter>}
 */
export const adapters = new Map([
  ['codex', codexAdapter],
  ['devin', devinAdapter],
  ['claude', claudeAdapter],
  ['antigravity', antigravityAdapter],
  ['muse', museAdapter],
  ['deepseek', deepseekAdapter],
  ['openrouter', openrouterAdapter],
]);
