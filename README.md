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
| `muse-code` | Muse | 5H / 7D quota | the `pi-muse-bridge` extension |
| `claude-bridge`, `anthropic` | Claude | session / week quota | `pi-claude-bridge` for the former; see the caveat below |
| `devin`, plus one per extra account | D1, D2 | weekly quota | the `pi-devin` extension |
| `antigravity` | AGY, Ext | Gemini and third-party quota | the `@estebanforge/pi-antigravity-bridge` extension |

**Several of these rows do not exist without a third-party extension.**
`muse-code`, `claude-bridge`, `devin` and `antigravity` are registered by the
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

**Pi's own credential store** — `openai-codex`, `deepseek`, `openrouter`, and
every `devin*`. Configure them in pi and you are done. The token is resolved at
poll time and only a hash of it is ever stored, as the account id.

**The provider's own CLI** — `claude`, `antigravity`, `muse`. These read the
credential that CLI already keeps locally:

| Provider | Read from | Produced by |
| --- | --- | --- |
| `claude` | `~/.claude/.credentials.json` | `claude` sign-in |
| `antigravity` | OS keyring, `service=gemini username=antigravity` | `agy` sign-in |
| `muse` | `~/.config/muse/auth.json` | `muse` sign-in |

The panel never logs in for you and never writes these files. If a row is
missing or errored, sign in with that provider's own CLI first. Because these are
read at poll time, a refresh performed by the CLI is picked up on the next poll.

**Caveat on `anthropic`.** pi has a built-in `anthropic` provider for a plain API
key, but this package's Claude route reads the **Claude CLI's** subscription
credential. An Anthropic API key alone is therefore not enough to populate that
row; sign in with the `claude` CLI.

### Subscription-backed vs API-billed

Both appear; they measure different things.

- **Subscription-backed** (`openai-codex`, `claude`, `devin`, `antigravity`,
  `muse`) report a **quota window** — percent remaining plus its reset time.
- **API-billed** (`deepseek`, `openrouter`) have no window to report, so they
  report the account's **prepaid balance**, in the `Credits` cell.

## Acquisition

Every provider is read in one HTTP request. No TUI is driven, no PTY is
allocated, and no provider CLI is executed.

| Row | Source |
| --- | --- |
| Codex | `GET chatgpt.com/backend-api/wham/usage` — OAuth token; the account id is a claim inside the token |
| D1 / D2 | Connect RPC `server.codeium.com/…SeatManagementService/GetUserStatus` (protobuf) |
| Claude | `GET api.anthropic.com/api/oauth/usage` |
| AGY / Ext | `POST daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` |
| Muse | `POST api.meta.ai/muse-code/key` → `subs_usage` |
| DS | `GET api.deepseek.com/user/balance` |
| OR | `GET openrouter.ai/api/v1/credits` |

The only subprocess is `secret-tool`, reading one keyring item for antigravity.

Details that are easy to get wrong, kept here because each one cost real time:

- **Codex** — the account id is a nested claim in the access token
  (`https://api.openai.com/auth` → `chatgpt_account_id`).
- **Devin** — authenticates with `Basic <key>-<key>`, i.e. the key duplicated
  around a hyphen and **not** base64-encoded; the body is protobuf and the weekly
  figure is `plan_status` field 15, where absent means 0.
- **Antigravity** — must use the **`daily-` host**; production
  `cloudcode-pa.googleapis.com` answers `403` for this method. Its token is in
  the OS keyring, *not* in `~/.gemini/oauth_creds.json`, which is a different
  credential and 403s.
- **Muse** — `subs_usage` is omitted in some subscription states. An absent
  measurement is never rendered as `0%`: the row reports an error instead.
  It reappears once the account has activity (a single message to muse
  re-ups it), so the row clears on its own.

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
| `CLAUDE_CREDENTIALS_PATH` | Override the Claude credentials file location |
| `XDG_RUNTIME_DIR` | Standard; how the D-Bus keyring is reached for antigravity |

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

All eight sources have been verified against the live endpoints — codex, devin
(both accounts), claude, antigravity, muse, deepseek and openrouter.

Known limits:

- Linux only. The abstract-socket-free design still leans on `secret-tool` and
  the D-Bus keyring for antigravity, and on `/proc`-free but Linux-specific
  credential locations for the rest.
- A couple of provider rows depend on undocumented endpoints. They are exercised
  by tests and covered by `dropped` reporting, but a backend change would show as
  an error row until the parse is updated.
- A `pi install` from npm or git has not been exercised; only a local-path
  install.
