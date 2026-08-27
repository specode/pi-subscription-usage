# Pi subscription usage

Unified view of the current Pi account's subscription quota across these providers:

- OpenAI Codex: 5h/weekly quota, extra model quota, reset credits with confirmed redemption.
- OpenCode Go: 5h, weekly, and monthly windows.
- Grok: weekly or monthly window; only accepts Pi's `xai` / `xai-auth` OAuth and verifies account identity first.
- Kimi Coding: 5h and weekly windows.

The plugin does not implement or modify Codex Fast mode and never rewrites model requests.

## Usage

With the plugin installed, run:

```text
/usage
```

Every `/usage` call skips the cache and re-queries the current provider, showing per-window remaining quota with `MM/DD HH:mm` reset times in a uniform format. Codex is grouped by quota domain: `Shared Across Models` first, then each model-specific section, then `Account` — windows from different domains are never interleaved. The command no longer offers refresh, other-provider, or all-provider menus; run `/usage` again to refresh.

The reset menu only appears when the current provider is Codex and redeemable reset credits were found. Grok's current API only exposes quota windows and natural reset times, with no verified manual reset endpoint or credit count, so the plugin never fakes a reset action.

Status output has two layers: the plugin provides a plain default string via `setStatus` without provider name or icons (e.g. `5h 99% · 1w 85% · 1m 60%`), and publishes structured window data through `subscription-usage/status/v1`; windows are always ordered `5h / 1w / 1m / other`. session-ui can consume that event to supply its own Nerd Font icons, colors, and layout without parsing the display string.

Before a Codex reset is consumed, the plugin:

1. Confirms the current model is still Codex;
2. Confirms the Pi runtime token matches the local `/login` OAuth account exactly;
3. Shows the reset to be consumed and asks for final confirmation — the selector's first item is always `Cancel (Default)`, and only deliberately choosing the second item proceeds;
4. Uses a unique request ID, reused across retries.

## Install into this repo's Pi config

Run:

```bash
./install-harness.sh pi
```

The installer copies this whole directory to:

```text
~/.pi/agent/extensions/subscription-usage/
```

Pi discovers its `index.ts` automatically. For development you can load it directly:

```bash
pi --no-extensions --offline \
  -e ./harnesses/pi/agent/extensions/subscription-usage/index.ts \
  --list-models
```

## Tests

```bash
node --test harnesses/pi/agent/extensions/subscription-usage/test/*.test.ts
```

## Security boundaries

- Usage queries resolve credentials only through `ctx.modelRegistry.getProviderAuth()`.
- Codex reset additionally reads Pi's stored OAuth credential through the public `readStoredCredential()` API, solely to verify that it exactly matches the active runtime account before redemption.
- Grok never reads `~/.grok/auth.json` and never accepts an API key in place of subscription OAuth.
- Credentials are never written to caches, sessions, the statusline, or error messages; cache keys store only in-process HMAC fingerprints.
- Credentials are only sent to the corresponding official domains; custom proxies and custom base URLs are rejected.
- Codex reset is the only write operation. It is only shown when redeemable credits exist and always requires explicit user confirmation.

## Stability notes

Codex reset, Grok billing, and Kimi usage rely on undocumented provider APIs that may change.
When an API fails, the plugin only reports the query error and never falls back to uncontrolled credential or proxy paths.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party sources and licenses.
