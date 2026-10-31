# pi-subscription-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

View your active subscription quota directly inside [Pi](https://github.com/earendil-works/pi-mono) — in the footer status bar and via `/usage` — across OpenAI (ChatGPT), OpenAI Codex, OpenCode Go, xAI Grok, Kimi Coding, and Antigravity.

- **One consistent view** — 5-hour, weekly, and monthly quota windows rendered with uniform progress bars and `MM/DD HH:mm` reset times.
- **Live footer countdown** — compact status bar summary (e.g. `5h 99% ↻2h13m · 1w 85% ↻3d4h`) that updates automatically after each turn and every 5 minutes.
- **Safe reset-credit redemption** — verify and redeem available OpenAI / Codex rate-limit reset tickets with strict account matching and explicit confirmation.
- **Zero credential leakage** — reads tokens strictly from Pi's provider registry in memory, never touches browser cookies, and never rewrites model requests.

---

## Requirements

- [Pi](https://github.com/earendil-works/pi-mono) installed and logged in to at least one supported subscription via `/login`:

| Provider | Required Pi Login | Quota Windows Shown | Manual Reset Credits |
| --- | --- | --- | --- |
| **OpenAI (ChatGPT)** | `openai` **and** `openai-codex` (same account/workspace)¹ | `Plan limits` + active app limits | Yes (`Account Resets`) |
| **OpenAI Codex** | `openai-codex` | `5h`, `1w`, model-specific windows | Yes (`Resets Left`) |
| **OpenCode Go** | `opencode` | `5h`, `1w`, `1m` | — |
| **xAI Grok** | `xai` / `xai-auth` | `1w` and/or `1m` | — |
| **Kimi Coding** | `kimi` | `5h`, `1w`, membership plan | — |
| **Antigravity** | `antigravity`² | `5h` + `1w` (Gemini), `5h` + `1w` (Claude/GPT), `1w` (Argon) | — |

> ¹ **Why does OpenAI require a one-time `/login openai-codex`?** OpenAI rejects `Sign in with ChatGPT` tokens on its usage and reset endpoints (`HTTP 401`). Run `/login openai-codex` once with the same ChatGPT account/workspace so the extension can query quota, while keeping `openai` as your active model.
>
> ² **Antigravity requires the [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) extension.** Pi has no built-in Antigravity provider; install it with `pi install npm:pi-antigravity`, then run `/login antigravity`. The quota summary requires a paid Google AI subscription; free-tier accounts are shown as unsupported instead of an error.

---

## Installation

Install from npm:

```bash
pi install npm:@specode/pi-subscription-usage
```

Or install directly from GitHub:

```bash
pi install git:github.com/specode/pi-subscription-usage
```

For local development:

```bash
pi install /absolute/path/to/pi-subscription-usage
```

> **Note:** Pi packages run with your user permissions. Review third-party source code before installing.

---

## Quick Start

1. Make sure your subscription account is logged in (`/login`).
2. Check your current quota at any time:

```text
/usage
```

Every `/usage` call bypasses the local cache and fetches live numbers for the active provider:

- **Footer status bar** automatically displays your active windows (`5h 99% ↻2h13m · 1w 85% ↻3d4h`).
- **OpenAI / Codex Reset**: When your account has redeemable reset tickets, `/usage` presents an option to consume a ticket after explicit confirmation (`Cancel (Default)` is always selected first).

---

## Usage & Configuration

### Display Mode (`remaining` vs `used`)

By default, percentages show **remaining** quota. To switch to **used** quota, create a global config at `~/.pi/agent/subscription-usage.json` or a trusted project override at `.pi/subscription-usage.json`:

```json
{
  "displayMode": "used"
}
```

| Value | Meaning |
| --- | --- |
| `"remaining"` | Show remaining quota percentage (default) |
| `"used"` | Show consumed quota percentage |

Run `/reload` after updating the configuration file. `displayMode` applies to the footer status bar, `/usage` progress bars, and structured status events.

### How `/usage` Organizes Quota Windows

- **OpenAI (ChatGPT)**: Separates website `Plan limits` from the current app's limits (`App Allowance` shows the configured cap share, not remaining quota). Footer status tracks `Plan limits` to match the ChatGPT usage page.
- **OpenAI Codex**: Groups windows into `Shared Across Models`, model-specific sections, and `Account` (including the local OAuth email when present). Domains are never interleaved.
- **xAI Grok**: Displays weekly and/or monthly windows in the same `5h / 1w / 1m` format. If `creditUsagePercent` is omitted by proto3 after a weekly reset, it is treated as `0%` used.
- **Antigravity**: Separates quota into three independent shared pools: **Gemini Models** (5-hour and weekly limits for Gemini Flash and Pro), **Claude and GPT models** (5-hour and weekly limits for Claude Opus/Sonnet and GPT-OSS), and **Gemini 4 Argon** (weekly limit). The footer selects a pool from the active model id (`claude`, `gpt-oss`, or `argon`); an unrecognized model shows the Gemini pool when that pool is present.

---

## Architecture & Design

### OpenAI & Codex Reset Safety

Redeeming a rate-limit reset credit is the only write operation in this extension. Both OpenAI and Codex modes query `/wham/rate-limit-reset-credits` and `/consume` using the Codex backend credential scoped to `chatgpt-account-id`:

1. **Ticket-level verification**: Only explicit, available, plan-supported, unexpired `codex_rate_limits` tickets are counted and offered. Summary counts alone never trigger a blind server-chosen reset.
2. **Pre-flight identity checks**: Before redeeming, the extension verifies that the active model and account have not changed, and confirms via `readStoredCredential()` that the runtime token matches Pi's stored OAuth credential (plus app registration matching in OpenAI mode).
3. **Explicit scope & idempotency**: In OpenAI mode, the confirmation dialog clearly notes that tickets reset server-defined account windows rather than guaranteeing an app-specific reset. Redemption uses a unique request ID across retries and invalidates both providers' usage caches on success.

### Status Event Bus (`subscription-usage/status/v1`)

In addition to setting Pi's plain footer status (`setStatus`), the extension emits structured events on `subscription-usage/status/v1` so custom themes or status extensions can render their own icons, colors, and layouts without parsing strings:

- Windows are ordered deterministically: `5h` → `1w` → `1m` → `other`.
- Ready payloads expose `displayMode`, and each window carries `displayPercent`, `remainingPercent`, `usedPercent`, and `resetCountdown` (when a future `resetsAt` timestamp is reported).

### Security & Stability Boundaries

- **Official endpoints only**: Credentials are resolved through `ctx.modelRegistry.getProviderAuth()` and sent strictly to official provider domains. Custom proxies and base URLs are rejected.
- **No external file snooping**: Grok never reads `~/.grok/auth.json` or falls back to API keys.
- **In-memory privacy**: Tokens are never written to caches, session files, status bars, or error logs; cache keys use in-process HMAC fingerprints.
- **Fail-safe on undocumented APIs**: OpenAI app usage, Codex resets, Grok billing, and Kimi usage rely on undocumented provider endpoints. If an endpoint changes or accounts mismatch, the extension reports a clear error rather than guessing or showing another account's quota.

---

## Development

```bash
# Run the test suite (requires Node.js with native TypeScript support)
npm test

# Inspect npm package contents
npm run pack:check

# Load the extension directly in Pi without installing
pi --no-extensions --offline -e ./index.ts --list-models
```

## License

[MIT](./LICENSE). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for adapted third-party sources and licenses.
