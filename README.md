# pi-subscription-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

A [Pi](https://github.com/earendil-works/pi-mono) extension that shows your active provider's subscription quota in the footer status bar and a full breakdown via `/usage`.

Footer status bar:

```text
5h 99% ↻2h13m · 1w 85% ↻3d4h
```

`/usage` output:

```text
OpenAI Codex
  Shared Across Models:
    5h Window     ████████████   99% left · resets 08/27 12:13
    1w Window     ██████████░░   85% left · resets 08/30 14:00

  gpt-5.6-spark:
    5h Window     █░░░░░░░░░░░   10% left · resets 08/27 11:40

  Account:
    Email         user@example.com
    Plan          Pro
    Resets Left   2
    Extra Credit  none
```

## Supported Providers

To sign in, run `/login`, pick `Sign in with an account` (Account below) or `Sign in with an API key` (API key below), then pick the name shown in the table.

| Provider | `/login` option | Quota shown | Reset credits | Extra extension |
| --- | --- | --- | --- | --- |
| OpenAI (ChatGPT) | Account → `OpenAI`, and Account → `OpenAI Codex (legacy)` | ChatGPT plan limits, current app limits | Yes (`Account Resets`) | |
| OpenAI Codex | Account → `OpenAI Codex (legacy)` | `5h`, `1w`, model-specific windows, account email | Yes (`Resets Left`) | |
| OpenCode Go | API key → `OpenCode Go` | `5h`, `1w`, `1m` | — | |
| xAI Grok | Account → `xAI` | `1w` and/or `1m` | — | |
| Kimi Coding | Account → `Kimi For Coding` | `5h`, `1w`, membership level | — | |
| Antigravity | Account → `Antigravity` | Gemini (`5h`, `1w`), Claude and GPT (`5h`, `1w`), Gemini 4 Argon (`1w`), plan, email, project | — | [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) |

### Provider Notes

#### OpenAI (ChatGPT)

Sign in to both `OpenAI` and `OpenAI Codex (legacy)` with the same ChatGPT account and workspace, then keep chatting with an `OpenAI` model. OpenAI rejects the `OpenAI` sign-in on its usage endpoints, so the extension uses the `OpenAI Codex (legacy)` sign-in only to read usage. `/usage` lists website `Plan limits` separately from the current app's limits (`App Allowance` shows the configured cap share, not remaining quota), and the footer tracks `Plan limits`.

#### xAI Grok

Sign in with your SuperGrok account (Account → `xAI`). Signing in with an xAI API key does not show subscription quota. If you use the third-party `pi-xai-oauth` extension instead, its sign-in works too.

#### Antigravity

Install [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) first (`pi install npm:pi-antigravity`). `Antigravity` then appears under `Sign in with an account` in `/login`. Quota is split into three separate shared pools: Gemini models (`5h` and `1w`), Claude and GPT models (`5h` and `1w`), and Gemini 4 Argon (`1w`). The footer shows the pool of the model you are using: Claude and GPT-OSS models show the Claude and GPT pool, Gemini 4 Argon shows the Argon pool, and other Gemini models show the Gemini pool. Quota data requires a paid Google AI subscription; free-tier accounts show `Unsupported` in `/usage` and display nothing in the footer instead of an error.

## Installation

From npm:

```bash
pi install npm:@specode/pi-subscription-usage
```

From GitHub:

```bash
pi install git:github.com/specode/pi-subscription-usage
```

From a local directory for development:

```bash
pi install /path/to/pi-subscription-usage
```

## Usage

Sign in through `/login` as described above, then select a model from that provider. From then on:

- The footer status bar shows the active quota windows and refreshes after each turn and every 5 minutes (using a 5-minute cache).
- Running `/usage` always fetches fresh data for the active provider and shows progress bars, reset times (`MM/DD HH:mm`), and account details.

### Reset Credits (OpenAI and Codex)

When your OpenAI or Codex account has redeemable rate-limit reset tickets, `/usage` offers to use one:

- `Cancel (Default)` is selected by default, and an explicit confirmation is required before a ticket is consumed.
- Before redeeming, the extension checks that the active model and account have not changed and that the runtime token matches Pi's stored OAuth login.
- In OpenAI mode, a ticket resets server-defined account windows rather than specifically clearing the current app's limits.
- Redeeming a reset ticket is the only write operation in this extension.

## Configuration

Percentages show remaining quota by default. To show used quota instead, create `~/.pi/agent/subscription-usage.json` (global) or `.pi/subscription-usage.json` (trusted project override):

```json
{
  "displayMode": "used"
}
```

| Value | Description |
| --- | --- |
| `"remaining"` | Show remaining quota percentage (default) |
| `"used"` | Show used quota percentage |

Run `/reload` after changing the config file. `displayMode` applies to the footer status bar, `/usage` progress bars, and status events.

## Privacy and Safety

- Credentials come only from Pi's own login (provider registry). The extension never reads browser cookies or other tools' credential files (for example, Grok never reads `~/.grok/auth.json`).
- Requests go only to each provider's official endpoints. Custom proxies and custom base URLs are refused.
- Tokens are never written to caches, session files, the status bar, or error messages.
- The extension does not modify model requests.
- Several provider usage endpoints are undocumented. If an endpoint changes, the extension shows an error rather than guessing.

## Development

```bash
# Run tests (requires Node.js with native TypeScript support)
npm test

# Check package contents
npm run pack:check

# Load the extension directly in Pi without installing
pi --no-extensions --offline -e ./index.ts --list-models
```

### Status Events for Theme and Extension Authors

The extension emits structured events on `subscription-usage/status/v1` so custom themes or status extensions can render quota data without parsing the footer string. Windows are ordered `5h` -> `1w` -> `1m` -> other. Ready payloads include `displayMode` and, for each window, `displayPercent`, `remainingPercent`, `usedPercent`, and `resetCountdown`.

## License

[MIT](./LICENSE). See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for adapted sources and licenses.
