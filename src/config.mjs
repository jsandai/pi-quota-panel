/**
 * Panel configuration — which surfaces the panel draws on.
 *
 * Read once at session_start from a JSON file. Two independent toggles:
 *   widget : the expanded quota grid mounted belowEditor (the main surface)
 *   chip   : the compact "Label NN%" fragment injected into pi's footer
 *            status line via setStatus
 *
 * Both default to true so an install with no config behaves exactly as before.
 * Environment variables override the file for quick experiments:
 *   PI_QUOTA_PANEL_WIDGET=0|1   PI_QUOTA_PANEL_CHIP=0|1
 *
 * Resolution order for the config path:
 *   $PI_QUOTA_PANEL_CONFIG  ->  $PI_CODING_AGENT_DIR/pi-quota-panel.json
 *                           ->  ~/.pi/agent/pi-quota-panel.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULTS = { widget: true, chip: true };

export function configPath() {
  const override = process.env.PI_QUOTA_PANEL_CONFIG?.trim();
  if (override) return override;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
  return join(agentDir, 'pi-quota-panel.json');
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function envBool(name) {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return true;
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return undefined;
}

/**
 * Load the surface toggles. Never throws — a missing or malformed file falls
 * back to defaults so a bad config can never take the panel down with it.
 * @returns {{widget:boolean, chip:boolean}}
 */
export function loadConfig() {
  let file = {};
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    if (parsed && typeof parsed === 'object') file = parsed;
  } catch {
    /* absent or unreadable config is fine — defaults apply */
  }
  return {
    widget: envBool('PI_QUOTA_PANEL_WIDGET') ?? bool(file.widget, DEFAULTS.widget),
    chip: envBool('PI_QUOTA_PANEL_CHIP') ?? bool(file.chip, DEFAULTS.chip),
  };
}

/**
 * Persist the toggles to the config file, preserving any unknown keys already
 * on disk so a hand-edited file isn't clobbered by a settings-menu write.
 * @param {{widget:boolean, chip:boolean}} cfg
 * @param {string} [path]
 */
export function saveConfig(cfg, path = configPath()) {
  let existing = {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) existing = raw;
  } catch {
    /* nothing to preserve */
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...existing, widget: cfg.widget, chip: cfg.chip }, null, 2) + '\n', 'utf8');
}

/** SettingItem descriptors for the /quota-panel settings menu. */
export function settingItems() {
  return [
    { id: 'widget', label: 'Usage grid (below editor)', values: ['on', 'off'], path: ['widget'] },
    { id: 'chip', label: 'Footer status chip', values: ['on', 'off'], path: ['chip'] },
  ];
}

/** @param {{widget:boolean,chip:boolean}} cfg @param {string[]} path */
export function getSetting(cfg, path) {
  /** @type {any} */
  let cur = cfg;
  for (const k of path) cur = cur?.[k];
  return cur === true ? 'on' : cur === false ? 'off' : 'on';
}

/** @param {{widget:boolean,chip:boolean}} cfg @param {string[]} path @param {string} value */
export function setSetting(cfg, path, value) {
  const b = value === 'on';
  if (path[0] === 'widget') cfg.widget = b;
  else if (path[0] === 'chip') cfg.chip = b;
}
