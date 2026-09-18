import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readingKey } from './poll.mjs';

/**
 * Snapshot cache: the last readings, so a new session paints them immediately
 * instead of showing an empty panel for the first second.
 *
 * A cache file is the only shared state this package has. Everything in it is
 * derived from a reading, which carries a hash for the account rather than a
 * credential, so nothing here identifies a token or a key.
 *
 * A corrupt or unreadable cache is not an error — it is a cold start.
 */

const VERSION = 1;

/** @param {string} [override] */
export function cachePath(override) {
  const root = override?.trim() || process.env.PI_QUOTA_PANEL_ROOT?.trim()
    || join(homedir(), '.local', 'share', 'pi-quota-panel');
  return join(root, 'readings.json');
}

/**
 * @param {string} [override]
 * @returns {Promise<Map<string,any>>}
 */
export async function readCache(override) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(override), 'utf8'));
    if (parsed?.version !== VERSION || !Array.isArray(parsed.readings)) return new Map();
    const out = new Map();
    for (const reading of parsed.readings) {
      const id = reading?.identity;
      // Shape-check rather than trust: a hand-edited or truncated file must not
      // put a malformed reading in front of the renderer.
      if (typeof id?.provider !== 'string' || typeof id?.account !== 'string' || typeof id?.metric !== 'string') continue;
      if (reading.value != null && typeof reading.value !== 'object') continue;
      out.set(readingKey(id), reading);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Write atomically: a reader must never see a half-written file.
 * @param {Map<string,any>} readings
 * @param {string} [override]
 */
export async function writeCache(readings, override) {
  const path = cachePath(override);
  const payload = JSON.stringify({ version: VERSION, readings: [...readings.values()] });
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;   // a cache that cannot be written is not a failure of the panel
  }
}
