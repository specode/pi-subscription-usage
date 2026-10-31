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
| Antigravity | Account → `Antigravity` | Gemini (`5h`, `1w`), Claude and GPT (`5h`, `1w`), Gemini 4 Argon (`1w`), plan, email, project | — | [`pi-antigravity`](https://www.npmjs.com/package/pi-antigravity) |
| Claude (Claude Code) | None; signed in through Claude Code | `5h`, `1w` | — | [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge) 0.9.3 or later |

### Provider Notes

#### OpenAI (ChatGPT)

Sign in to both `OpenAI` and `OpenAI Codex (legacy)` with the same ChatGPT account and workspace, then keep chatting with an `OpenAI` model. OpenAI rejects the `OpenAI` sign-in on its usage endpoints, so the extension uses the `OpenAI Codex (legacy)` sign-in only to read usage. `/usage` lists website `Plan limits` separately from the current app's limits (`App Allowance` shows the configured cap share, not remaining quota), and the footer tracks `Plan limits`.

#### xAI Grok

Sign in with your SuperGrok account (Account → `xAI`). Signing in with an xAI API key does not show subscription quota. If you use the third-party `pi-xai-oauth` extension instead, its sign-in works too.

#### Antigravity

Requires [`pi-antigravity`](https://www.npmjs.com/package/pi-antigravity) by Rahul Arya ([GitHub](https://github.com/Rahularya01/pi-antigravity)). Install it with `pi install npm:pi-antigravity`; `Antigravity` then appears under `Sign in with an account` in `/login`. Quota is split into three separate shared pools: Gemini models (`5h` and `1w`), Claude and GPT models (`5h` and `1w`), and Gemini 4 Argon (`1w`). The footer shows the pool of the model you are using: Claude and GPT-OSS models show the Claude and GPT pool, Gemini 4 Argon shows the Argon pool, and other Gemini models show the Gemini pool. Quota data requires a paid Google AI subscription; free-tier accounts show `Unsupported` in `/usage` and display nothing in the footer instead of an error.

Tested with `pi-antigravity` 0.11.0. Every earlier version back to 0.1.0 registers the same provider id, Google endpoint, and credential format, so they are expected to work too.

Several packages have similar names. The extension recognizes the `antigravity` provider id and reads quota from Google's Cloud Code API with the credential Pi resolves for it, so the package must register that id and serve models from Google's endpoint. Install only one package that registers `antigravity`. As of October 31, 2026:

| Package | Result |
| --- | --- |
| `pi-antigravity` | Works |
| `@gwylook/pi-antigravity`, `@dereknex/pi-antigravity` (forks of `pi-antigravity`), `@heyhuynhgiabuu/pi-oauth-antigravity`, `@raquezha/antigravity`, `pi-provider-antigravity` | Same provider id, Google endpoint, and credential format; expected to work, untested |
| `@estebanforge/pi-antigravity-bridge`, `@thoth-agents/pi-antigravity-bridge` | Register `antigravity` but run models through a local Antigravity bridge (`agy-bridge://`): unsupported, so the footer stays empty and `/usage` explains why |
| `@cortexkit/pi-antigravity-auth` (`google`), `pi-antigravity-acp-provider` and `@dapidev/pi-antigravity-pure` (`antigravity-acp`), `@ackneal/pi-agy-bridge` (`agy`) | Register a different provider id; not supported |

#### Claude (Claude Code)

Requires [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge) by elidickinson ([GitHub](https://github.com/elidickinson/pi-claude-bridge)), version 0.9.3 or later. 0.9.3 is the first version that passes Claude Code's usage reports on to Pi. Install it with `pi install npm:pi-claude-bridge` and sign in to Claude Code itself; there is no Pi login. Usage covers models under the `claude-bridge` provider; Claude models served by Antigravity use the Antigravity pool above.

The bridge has no usage endpoint to query: Claude Code attaches your plan usage to its responses, and the extension reads that report. So the footer stays empty in each new session until the first report arrives, `/usage` shows the last reported values with the time they were reported instead of fetching, and a window whose reset time has passed shows as unused until the next report. The extension never reads Claude Code's credentials.

Tested with `pi-claude-bridge` 0.9.3 and Claude Code 2.1.311, the version bundled with the bridge's Agent SDK. If you point the bridge at your own `claude` executable (`pathToClaudeCodeExecutable`), older Claude Code versions are untested.

Several packages have similar names. The extension recognizes the `claude-bridge` provider id, so the package must both register that id and pass usage reports on. As of October 31, 2026:

| Package | Result |
| --- | --- |
| `pi-claude-bridge` 0.9.3 or later | Works |
| `@viniciosrab/pi-claude-bridge` 0.9.4-fork.3 | Same usage code as 0.9.3; expected to work, untested |
| `pi-claude-bridge` before 0.9.3, `@fractaal/pi-claude-bridge`, `@yassimba/pi-claude-bridge`, `@agimon-ai/po-claude-bridge` | Register `claude-bridge` but never pass usage on: the footer stays empty and `/usage` keeps showing `Waiting` |
| `@vanillagreen/pi-claude-bridge`, `pi-claude-subscription`, `pi-claude-directsdk`, `@ramtinj95/pi-claude-delegation` | Register a different provider id; not supported |

The npm package `claude-bridge`, without the `pi-` prefix, is an unrelated proxy server for the Claude Code CLI; `pi install npm:claude-bridge` installs the wrong package. Run `pi list` to check which package you have.

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
- Claude is the exception: its quota is never fetched, only read from Claude Code's responses (see [Claude (Claude Code)](#claude-claude-code)).

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

- Credentials come only from Pi's own login (provider registry). The extension never reads browser cookies or other tools' credential files (for example, Grok never reads `~/.grok/auth.json`, and Claude usage comes from the bridge's responses, not Claude Code's keychain entry).
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
