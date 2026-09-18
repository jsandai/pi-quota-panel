/**
 * pi extension entry — a provider quota/credit panel.
 *
 * Everything runs in this process. There is no collector child, no socket, no
 * session handshake: on `session_start` we read the last snapshot off disk,
 * paint it, and kick off a poll. That means there is no second process to die
 * and nothing to reconnect to — the previous design's most common failure was a
 * panel that kept showing readings from a collector that had gone away.
 *
 * Rules honored here:
 *  - The factory registers handlers and starts nothing.
 *  - Startup is never blocked by a poll; the first one is fire-and-forget.
 *  - All resources are released in `session_shutdown`.
 *  - No acquisition happens during render.
 *
 * Commands: /quota-panel [on|off|toggle|refresh|detail|settings]
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { adapters } from "./adapters/index.mjs";
import { buildRequests } from "./providers.mjs";
import { pollOnce } from "./poll.mjs";
import { readCache, writeCache } from "./cache.mjs";
import { loadConfig, saveConfig, settingItems, getSetting, setSetting } from "./config.mjs";
import { groupRows, layout, severity } from "./render.mjs";

const WIDGET_KEY = "quota-panel";
const STATUS_KEY = "quota-panel-active";
const STALE_MS = 15 * 60_000;

/** Provider polling cadence. */
const POLL_MS = Math.max(30_000, Number(process.env.PI_QUOTA_PANEL_POLL_MS ?? 5 * 60_000));
/** How often the row grid recomputes (so resets go stale on their own). */
const REFRESH_MS = Math.max(0, Number(process.env.PI_QUOTA_PANEL_REFRESH_MS ?? 15_000));

/** Apply a render.mjs span list through the live theme. */
function paintLine(theme: any, line: { text: string; spans: Array<[number, number, string]> }): string {
  let out = "";
  let cursor = 0;
  for (const [s, e, level] of line.spans) {
    out += line.text.slice(cursor, s);
    out += theme.fg(level as any, line.text.slice(s, e));
    cursor = e;
  }
  out += line.text.slice(cursor);
  return out;
}

export function createPanel(pi: ExtensionAPI): void {
  let visible = true;
  let mounted = false;
  let readings = new Map<string, any>();
  let requests: Array<{ provider: string; adapter: string; config: any }> = [];
  let dropped: Array<{ provider: string; reason: string }> = [];
  let activeProvider: string | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Which surfaces to draw on, from pi-quota-panel.json (both default on). */
  let config = { widget: true, chip: true };
  /** The live TUI component, if one is mounted, so a poll can repaint it. */
  let repaint: (() => void) | null = null;
  /** Why the last poll cycle failed, if it did. `detail` shows it. */
  let cycleError: string | null = null;

  const stopTimers = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const rows = () =>
    groupRows([...readings.values()], undefined, { now: Date.now(), staleMs: STALE_MS });

  function paint(ctx: any): void {
    if (!ctx?.ui) return;
    // `visible` is the master switch (/quota-panel off): it clears BOTH
    // surfaces. Within it, config.widget / config.chip gate each surface
    // independently.
    if (!visible) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, undefined);
      mounted = false;
      repaint = null;
      return;
    }
    if (!config.widget) {
      // Widget surface disabled: clear it but leave the chip free to render.
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      mounted = false;
      repaint = null;
      paintStatus(ctx);
      return;
    }
    if (ctx.mode === "tui") {
      if (!mounted) {
        ctx.ui.setWidget(WIDGET_KEY, widgetFactory(ctx), { placement: "belowEditor" });
        mounted = true;
      } else {
        repaint?.();
      }
    } else {
      const w = process.stdout?.columns ?? 0;
      const lines = layout(rows(), { width: w, activeProvider }).map((l) => paintLine(ctx.ui.theme, l));
      ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
      repaint = () => paint(ctx);
    }
    paintStatus(ctx);
  }

  function paintStatus(ctx: any): void {
    if (!config.chip) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const all = rows();
    const act = all.find((r: any) => r.provider === activeProvider) ?? all[0];
    const first = act && [...act.quota.values()].find((r: any) => r.value?.kind === "quota");
    if (!act) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS_KEY,
      first
        ? ctx.ui.theme.fg(severity(first.value.remainingPercent) as any, `${act.spec.label} ${Math.round(first.value.remainingPercent)}%`)
        : ctx.ui.theme.fg("dim", `${act.spec.label} —`),
    );
  }

  function widgetFactory(ctx: any) {
    return (_tui: any, factoryTheme: any) => {
      const theme = () => ctx.ui?.theme ?? factoryTheme;
      let cachedWidth = -1;
      let cachedLines: string[] = [];
      let sig = "";
      const recompute = (): boolean => {
        const next = JSON.stringify([
          activeProvider,
          [...readings.values()].map((r: any) => [r.identity.metric, r.value?.remainingPercent ?? r.value?.total ?? null, r.freshAt, r.error]),
        ]);
        if (next === sig) return false;
        sig = next;
        cachedWidth = -1;
        return true;
      };
      const timer =
        REFRESH_MS > 0
          ? setInterval(() => {
              if (recompute()) _tui.requestRender();
            }, REFRESH_MS)
          : null;
      (timer as any)?.unref?.();
      repaint = () => {
        if (recompute()) _tui.requestRender();
      };
      recompute();
      return {
        render(width: number) {
          const w = typeof width === "number" && width > 0 ? width : 0;
          if (w === cachedWidth && cachedLines.length) return cachedLines;
          cachedWidth = w;
          const painted = layout(rows(), { width: w, activeProvider }).map((l) => paintLine(theme(), l));
          cachedLines = painted.map((l) => (w > 0 && visibleWidth(l) > w ? truncateToWidth(l, w) : l));
          return cachedLines;
        },
        invalidate() {
          sig = "";
          cachedWidth = -1;
          recompute();
        },
        dispose() {
          if (timer) clearInterval(timer);
          if (repaint) repaint = null;
        },
      };
    };
  }

  /** One cycle: resolve requests, poll, persist, repaint. Never throws. */
  async function cycle(ctx: any): Promise<void> {
    try {
      const built = await buildRequests(ctx.modelRegistry);
      requests = built.requests;
      dropped = built.dropped;
      await pollOnce(requests, {
        adapters,
        readings,
        onReadings: () => {
          try {
            paint(ctx);
          } catch {
            /* a render failure must not abort polling */
          }
        },
      });
      await writeCache(readings);
      cycleError = null;
    } catch (error) {
      // A cycle that fails keeps the previous readings, which then age visibly.
      // Record why: a panel showing an ageing snapshot with no explanation is
      // indistinguishable from one that never started, which is the failure
      // this panel exists to avoid.
      cycleError = error instanceof Error ? error.message : String(error);
      if (process.env.PI_QUOTA_PANEL_DEBUG) {
        console.error(`[quota-panel] poll cycle failed: ${cycleError}`);
      }
    }
  }

  pi.on("session_start", async (_e: any, ctx: any) => {
    activeProvider = ctx.model?.provider ?? null;
    config = loadConfig();
    // Paint the last snapshot immediately, then poll without blocking startup.
    try {
      const cached = await readCache();
      if (cached.size && !readings.size) readings = cached;
    } catch {
      /* cold start */
    }
    paint(ctx);
    void cycle(ctx);
    stopTimers();
    pollTimer = setInterval(() => void cycle(ctx), POLL_MS);
    (pollTimer as any)?.unref?.();
  });

  pi.on("model_select", async (event: any, ctx: any) => {
    activeProvider = event?.model?.provider ?? activeProvider;
    paint(ctx);
  });

  pi.on("session_shutdown", async (_e: any, ctx: any) => {
    stopTimers();
    try {
      ctx?.ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* already gone */
    }
    mounted = false;
    repaint = null;
  });

  pi.registerCommand("quota-panel", {
    description: "Show, hide, toggle, refresh, inspect or configure the provider quota panel",
    getArgumentCompletions: (prefix: string) => {
      const subs = [
        { value: "on", label: "on", description: "Show the panel" },
        { value: "off", label: "off", description: "Hide the panel" },
        { value: "toggle", label: "toggle", description: "Toggle the panel" },
        { value: "refresh", label: "refresh", description: "Poll all providers now" },
        { value: "detail", label: "detail", description: "Per-account values, dropped providers, errors" },
        { value: "settings", label: "settings", description: "Toggle the grid and footer chip" },
      ];
      const filtered = subs.filter((s) => s.value.startsWith(prefix));
      return filtered.length ? filtered : null;
    },
    handler: async (args: string, ctx: any) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "settings") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("quota-panel settings needs an interactive TUI", "warning");
          return;
        }
        const items = settingItems().map((it) => ({
          id: it.id,
          label: it.label,
          values: it.values,
          currentValue: getSetting(config, it.path),
        }));
        // No {overlay:true}: this renders as a full-screen page like pi's own
        // /settings, not a floating pop-over.
        await ctx.ui.custom((_tui: any, theme: any, _kb: any, done: any) => {
          const container = new Container();
          container.addChild(new Text(theme.fg("accent", theme.bold("Quota panel settings")), 1, 1));
          container.addChild(new Text(theme.fg("dim", "reopen with /quota-panel settings · esc to close"), 1, 0));
          const list = new SettingsList(
            items,
            Math.min(items.length + 2, 14),
            getSettingsListTheme(),
            (id: string, newValue: string) => {
              const it = settingItems().find((x) => x.id === id);
              if (!it) return;
              setSetting(config, it.path, newValue);
              try {
                saveConfig(config);
              } catch {
                /* a read-only config dir shouldn't kill the page */
              }
              list.updateValue(id, newValue);
              paint(ctx);   // apply the toggle live
            },
            () => done(undefined),
          );
          container.addChild(list);
          return {
            render: (w: number) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => list.handleInput?.(data),
          };
        });
        return;
      }
      if (arg === "refresh") {
        await cycle(ctx);
        ctx.ui.notify("quota panel refreshed", "info");
        return;
      }
      if (arg === "detail") {
        const lines = rows().map((r: any) => {
          const parts = [`${r.spec.label} ${r.provider} (${r.account.slice(0, 8)})`];
          for (const [m, rd] of r.quota) {
            parts.push(`${m}=${rd.value ? Math.round(rd.value.remainingPercent) + "%" : (rd.error ?? "—")}`);
          }
          for (const b of r.balances) parts.push(`${b.value?.currency ?? ""} ${b.value?.total ?? "—"}`);
          if (r.stale) parts.push("[stale]");
          if (r.error) parts.push(`[${r.error}]`);
          return parts.join("  ");
        });
        if (dropped.length) lines.push("dropped: " + dropped.map((d) => `${d.provider}(${d.reason})`).join(" "));
        if (cycleError) lines.push(`last poll failed: ${cycleError}`);
        lines.push(`polling every ${Math.round(POLL_MS / 1000)}s; stale after ${Math.round(STALE_MS / 60_000)}m`);
        ctx.ui.notify(lines.length ? lines.join("\n") : "usage: no data", "info");
        return;
      }
      visible = arg === "on" ? true : arg === "off" ? false : !visible;
      if (visible) {
        mounted = false;
        paint(ctx);
        void cycle(ctx);
      } else {
        paint(ctx);
      }
      ctx.ui.notify(`quota panel ${visible ? "shown" : "hidden"}`, "info");
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createPanel(pi);
}
