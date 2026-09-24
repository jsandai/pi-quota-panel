# pi quota panel

A pi extension that shows each provider's remaining quota and prepaid credit in
a widget below the editor.

It reads every provider directly over HTTP, in the pi process. There is no
background service, no second process, no socket, and nothing to keep running
between sessions.

```sh
pi install git:github.com/jsandai/pi-quota-panel
```

Requires Linux and Node 22 or newer. That is the whole setup — the provider list
comes from pi, and a poll starts on its own.

Working on it:

```sh
npm install
npm test            # node --test test/*.test.mjs
npm run typecheck   # tsc over src (JSDoc-typed .mjs plus panel.ts)
```

## Configuring providers

Two separate things decide what you see, and they are configured in different
places.

### Which providers appear

This package has no provider list. It asks pi's model registry —
`ctx.modelRegistry.getAvailable()`, every provider with at least one available
model — and shows those. So a provider appears when **pi** is configured for it:
`/login`, an entry in `auth.json` or `models.json`, or an extension that
registers one.

Supported today, and what has to be installed for each row to exist at all:

| pi provider | Row | Measures | Provided by |
| --- | --- | --- | --- |
| `openai-codex` | Codex | 5H / 7D quota | built into pi |
| `deepseek` | DS | prepaid credit, USD | built into pi |
| `openrouter` | OR | prepaid credit, USD | built into pi |
| `meta` (legacy `muse-code`) | Muse | 5H / 7D quota | built into pi (`/login meta`) |
| `claude-bridge`, `anthropic` | Claude | session / week quota | `pi-claude-bridge` for the former; see the caveat below |
| `devin`, plus one per extra account | D1, D2 | weekly quota | the `pi-devin` extension |
| `antigravity` | AGY, Ext | Gemini and third-party quota | the `@estebanforge/pi-antigravity-bridge` extension |

**Several of these rows do not exist without a third-party extension.**
`claude-bridge`, `devin` and `antigravity` are registered by the
extensions above; without them pi has no such provider, the panel has nothing to
ask, and no row appears. That is not a failure — install the extension and the
row shows up.

A provider pi knows about but this package has no route for is reported rather
than silently missing. `/quota-panel detail` lists it with a reason:

```
dropped: some-provider(no-route)
dropped: other-provider(no-credential)
```

Accounts are handled the same way. An extension that exposes one provider per
account — as `pi-devin` does for a second Devin login — gets one row each, with
its own credential, and **nothing needs configuring here**. The route for Devin
matches the provider-id prefix, so any account id that extension registers is
picked up automatically.

### Where the credential comes from

This differs per provider and is worth knowing before filing a bug.

**Pi's own credential store** — `deepseek`, `openrouter`, and every `devin*`.
Configure them in pi and you are done. The token is resolved at poll time and
only a hash of it is ever stored, as the account id.

**Omarchy's agent-usage records** — `claude`, `openai-codex`, `meta`,
`antigravity`. These read the usage record Omarchy already maintains at
`~/.local/state/omarchy/agents/usage/<agent>.json`, so every pi session shares
Omarchy's single probe instead of each hitting the provider itself. No
credential is resolved here at all; Omarchy owns sign-in and refresh. (The
antigravity record is `gemini.json` — Omarchy's collector ids it `gemini`.)

The panel never logs in for you and never writes credential files. For the
Omarchy-routed rows, Omarchy owns the sign-in; if a row is missing or errored,
refresh Omarchy's record (`omarchy-agent-usage-update --force <agent>`).

**Caveat on `anthropic` and the Omarchy tap.** The Claude, Codex, Muse and
Antigravity rows show whatever Omarchy last wrote. If Omarchy's collector stalls, the row ages and is
marked stale; but Omarchy republishes last-good limits after a failed upstream
probe while still bumping its write timestamp, so a *running-but-failing*
collector can keep the row looking fresh while the number is old. That
distinction is not recoverable from the record file — the panel reports what
Omarchy reported.

### Subscription-backed vs API-billed

Both appear; they measure different things.

- **Subscription-backed** (`openai-codex`, `claude`, `devin`, `antigravity`,
  `muse`) report a **quota window** — percent remaining plus its reset time.
- **API-billed** (`deepseek`, `openrouter`) have no window to report, so they
  report the account's **prepaid balance**, in the `Credits` cell.

## Acquisition

Most providers are read in one HTTP request. Claude, Codex, Muse and
Antigravity are the exception: they read Omarchy's per-agent record file rather
than probing the provider directly, so the panel adds zero requests for them.
No TUI is driven, no PTY is allocated, and no provider CLI is executed.

| Row | Source |
| --- | --- |
| Codex | Omarchy record `~/.local/state/omarchy/agents/usage/codex.json` (limits via `codex app-server` RPC) |
| D1 / D2 | Connect RPC `server.codeium.com/…SeatManagementService/GetUserStatus` (protobuf) |
| Claude | Omarchy record `~/.local/state/omarchy/agents/usage/claude.json` (limits via `api.anthropic.com/api/oauth/usage`) |
| AGY / Ext | Omarchy record `~/.local/state/omarchy/agents/usage/gemini.json` (limits via `retrieveUserQuotaSummary`) |
| Muse | Omarchy record `~/.local/state/omarchy/agents/usage/muse.json` (limits via `POST api.meta.ai/muse-code/key`) |
| DS | `GET api.deepseek.com/user/balance` |
| OR | `GET openrouter.ai/api/v1/credits` |

No subprocess is spawned — the keyring read that antigravity used to need is
now Omarchy's job.

Details that are easy to get wrong, kept here because each one cost real time:

- **Claude / Codex / Muse / Antigravity** — read Omarchy's `limits[]`, where
  `percent` is a USED fraction in [0,1] mapped to remaining. Window matching is
  anchored (`/^weekly/` not `/week/`) so a model-scoped extra like "Fable
  Weekly" cannot steal the general weekly slot; the short windows use
  `/^\d+[hm] window$/i` so a duration change still lands, and Antigravity's
  third-party "Claude/GPT …" pair is matched separately into the external
  slots. A record is rejected unless its `id` matches the agent and it carries
  a parseable `updatedAt` — that timestamp is the record's publication time,
  which is what ages the row. These readings carry `source:'omarchy'` and get a
  longer stale window (35m) than directly-polled rows, because the collector
  rewrites the record on a ~900s cadence.
- **Devin** — authenticates with `Basic <key>-<key>`, i.e. the key duplicated
  around a hyphen and **not** base64-encoded; the body is protobuf and the weekly
  figure is `plan_status` field 15, where absent means 0.
- **Antigravity** — Omarchy's collector uses the **`daily-` host** (production
  `cloudcode-pa.googleapis.com` answers `403`) and the agy keyring token. That
  token lasts ~an hour and only agy refreshes it, so when agy has not run
  recently the record carries `usageStatusText` like "Sign-in expired" while
  republishing last-good limits — the running-but-failing case the `updatedAt`
  timestamp cannot distinguish.
- **Muse** — the upstream `subs_usage` field is omitted in some subscription
  states, so Omarchy may publish a record with no matching limits. An absent
  measurement is never rendered as `0%`: the row reports an error instead and
  clears once Omarchy next records real limits.

## Layout

Rows are a fixed order with short labels, two cells per line:

```
  D1      5H    —               7D  49% ↻9/20 03:00         D2      5H    —               7D   0% ↻9/20 03:00
  Claude  5H 100% ↻20:20        7D   3% ↻9/17 04:00         Codex   5H  94% ↻18:18        7D  84% ↻9/23 07:07
  AGY     5H  99% ↻20:10        7D 100% ↻9/23 15:10         Ext     5H 100% ↻20:40        7D  66% ↻9/19 14:18
  Muse    5H 100% ↻18:30        7D  99% ↻9/20 19:00         Credits DS     $0.58          OR     $2.51
```

Every cell is the same width whatever it holds, so a percentage going 100 → 0 or
a reset going from a clock time to a date never reflows the grid. In the credits
cell each balance is sized to one quota window block, so `DS` lines up under `5H`
and `OR` under `7D`. Below 108 columns the grid drops to one cell per line rather
than truncating.

A row whose reading is more than 15 minutes old gains a `⚠` rather than being
blanked or faked — a stale number is still useful, as long as it is labelled.

Commands:

| Command | Effect |
| --- | --- |
| `/quota-panel` | toggle the widget |
| `/quota-panel on` / `off` | show or hide it |
| `/quota-panel refresh` | poll now |
| `/quota-panel detail` | per-account values, dropped providers, errors |
| `/quota-panel settings` | toggle the widget grid and footer chip |

## Configuration

The two surfaces are toggled in `~/.pi/agent/pi-quota-panel.json` (or via
`/quota-panel settings`, which writes the same file):

| Key | Meaning |
| --- | --- |
| `widget` | Show the expanded quota grid below the editor (default `true`) |
| `chip` | Show the compact `Label NN%` fragment in pi's footer status line (default `true`) |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `PI_QUOTA_PANEL_POLL_MS` | Provider polling cadence (default 300000; floor 30000) |
| `PI_QUOTA_PANEL_REFRESH_MS` | Row recompute cadence (default 15000; `0` disables) |
| `PI_QUOTA_PANEL_ROOT` | Where the snapshot is cached (default `~/.local/share/pi-quota-panel`) |
| `XDG_STATE_HOME` | Standard; where the Omarchy agent-usage records are read from (default `~/.local/state`) |

## What is here

- `src/panel.ts` — the extension entry: widget, status line, commands, and the
  poll timer. Registers handlers only; starts no work until `session_start`.
- `src/providers.mjs` — which adapter serves which provider, and where that
  provider's credential comes from.
- `src/poll.mjs` — runs the adapters with bounded concurrency and a per-request
  timeout, and folds the results into readings. Its two rules: an absent
  measurement is never a number, and a failure never advances freshness.
- `src/cache.mjs` — the last snapshot on disk, written atomically, so a new
  session paints immediately instead of looking empty for a second. Accounts
  appear in it only as hashes.
- `src/render.mjs` — pure presentation. No I/O, no pi imports: plain data in,
  plain strings plus colour spans out.
- `src/adapters/` — one module per source, plus `http.mjs`, the shared bounded
  fetch (one request, one timeout, a response-size cap, redirects never
  followed, and errors that never echo a body or a header).

## Verification

45 offline tests pass on Linux (Node 22 and 26) and `npm run typecheck` is
clean, covering `panel.ts`. Every adapter is exercised against a mock server, so
both the request shape and the parse are pinned without a network or a
credential; the poller is tested for its honesty rules, including a hung adapter
that must not stall the cycle; the cache is tested for atomicity and for carrying
no credential material.

All sources have been verified against their live data — codex, devin
(both accounts), claude, antigravity, muse, deepseek and openrouter. (Claude,
Codex, Muse and Antigravity are verified against their Omarchy records, which
are themselves verified against the live endpoints.)

Known limits:

- Linux only. The Omarchy-routed rows depend on Omarchy's agent-usage records
  under `~/.local/state/omarchy/`; the rest lean on Linux-specific credential
  locations. There is no keyring/`secret-tool` dependency any more.
- A couple of provider rows depend on undocumented endpoints. They are exercised
  by tests and covered by `dropped` reporting, but a backend change would show as
  an error row until the parse is updated.
- A `pi install` from npm or git has not been exercised; only a local-path
  install.
