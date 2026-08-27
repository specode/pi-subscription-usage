# Pi Subscription Usage

[English](README.md) | [简体中文](README.zh-CN.md)

A Pi extension that shows the active account's subscription quota in one consistent view.

Supported providers:

- **OpenAI Codex** — 5-hour and weekly quota, model-specific quota, and confirmed reset-credit redemption.
- **OpenCode Go** — 5-hour, weekly, and monthly windows.
- **Grok** — weekly or monthly quota using only Pi's `xai` / `xai-auth` OAuth credentials, with account identity verification.
- **Kimi Coding** — 5-hour and weekly windows.

The extension does not implement or modify Codex Fast mode and never rewrites model requests.

## Installation

Install directly from GitHub:

```bash
pi install git:github.com/specode/pi-subscription-usage
```

After the npm package is published, it can also be installed with:

```bash
pi install npm:@specode/pi-subscription-usage
```

For local development:

```bash
pi install /absolute/path/to/pi-subscription-usage
```

Pi packages execute with your full system permissions. Review third-party package source before installing it.

## Usage

Run:

```text
/usage
```

Each invocation bypasses the cache and queries the current provider again. Quota windows use a uniform display with `MM/DD HH:mm` reset times.

Codex results are grouped by quota domain in this order:

1. `Shared Across Models`
2. Model-specific sections
3. `Account`

Windows from different domains are never interleaved. Run `/usage` again whenever you want to refresh; the command does not show refresh, provider-switching, or all-provider menus.

The reset menu appears only when Codex reports redeemable reset credits. Grok's current API exposes quota windows and natural reset times, but no verified manual-reset endpoint or reset-credit count, so the extension never invents a reset action.

## Codex reset safety

Before redeeming a Codex reset credit, the extension:

1. Verifies that the active model is still using Codex.
2. Verifies that the runtime token exactly matches the OAuth account stored by Pi through `/login`.
3. Shows the reset that will be consumed and asks for explicit confirmation. `Cancel (Default)` is always the first option; only deliberately choosing the second option continues.
4. Uses a unique request ID and reuses it across retries.

## Status integration

The extension publishes two status layers:

- A plain `setStatus` string without provider names or icons, such as `5h 99% · 1w 85% · 1m 60%`.
- Structured window data through the `subscription-usage/status/v1` event.

Windows are always ordered as `5h / 1w / 1m / other`. Other extensions can consume the structured event to provide their own icons, colors, and layout without parsing display text.

## Security boundaries

- Usage queries resolve credentials only through `ctx.modelRegistry.getProviderAuth()`.
- Codex reset additionally reads Pi's stored OAuth credential through the public `readStoredCredential()` API, solely to verify that it exactly matches the active runtime account before redemption.
- Grok never reads `~/.grok/auth.json` and never accepts an API key in place of subscription OAuth.
- Credentials are never written to caches, sessions, the status line, or error messages. Cache keys contain only in-process HMAC fingerprints.
- Credentials are sent only to the corresponding official domains. Custom proxies and custom base URLs are rejected.
- Codex reset is the only write operation. It is shown only when redeemable credits exist and always requires explicit confirmation.

## Development

Requirements:

- A current Pi installation.
- A Node.js version that can run TypeScript files directly for the test suite.

Run the tests:

```bash
npm test
```

Inspect the npm package contents:

```bash
npm run pack:check
```

Load the extension directly without installing it:

```bash
pi --no-extensions --offline -e ./index.ts --list-models
```

## Stability

Codex reset, Grok billing, and Kimi usage rely on undocumented provider APIs that may change. When an API fails, the extension reports the query error and does not fall back to uncontrolled credential or proxy paths.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for adapted third-party sources and licenses.
