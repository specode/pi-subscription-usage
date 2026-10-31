# pi-subscription-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个 [Pi](https://github.com/earendil-works/pi-mono) 扩展：在底部状态栏显示当前订阅还剩多少额度，输入 `/usage` 查看完整明细。

底部状态栏效果：

```text
5h 99% ↻2h13m · 1w 85% ↻3d4h
```

`/usage` 输出示例：

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

## 支持的提供商

登录方法：输入 `/login`，先选 `Sign in with an account`（下表记为 Account）或 `Sign in with an API key`（下表记为 API key），再在列表里选下表中的名称。Pi 界面只有英文，这里的选项名称都按界面原文写。

| 提供商 | `/login` 中选择 | 显示内容 | 重置券 | 额外扩展 |
| --- | --- | --- | --- | --- |
| OpenAI (ChatGPT) | Account → `OpenAI`，以及 Account → `OpenAI Codex (legacy)` | ChatGPT 套餐限额、当前应用限额 | 支持（`Account Resets`） | |
| OpenAI Codex | Account → `OpenAI Codex (legacy)` | `5h`、`1w`、模型专属窗口、账号邮箱 | 支持（`Resets Left`） | |
| OpenCode Go | API key → `OpenCode Go` | `5h`、`1w`、`1m` | — | |
| xAI Grok | Account → `xAI` | `1w` 和/或 `1m` | — | |
| Kimi Coding | Account → `Kimi For Coding` | `5h`、`1w`、会员等级 | — | |
| Antigravity | Account → `Antigravity` | Gemini（`5h`、`1w`）、Claude 与 GPT（`5h`、`1w`）、Gemini 4 Argon（`1w`）、套餐、邮箱、项目 | — | [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity) |

### 提供商说明

#### OpenAI (ChatGPT)

用同一个 ChatGPT 账号和工作区，分别登录 `OpenAI` 和 `OpenAI Codex (legacy)`，平时对话继续用 `OpenAI` 下的模型就行。OpenAI 的用量接口不认 `OpenAI` 这个登录，所以扩展只借 `OpenAI Codex (legacy)` 的登录来读额度。`/usage` 会将网页端的套餐总限额（`Plan limits`）与当前应用限额分开显示（`App Allowance` 表示该应用的配额上限比例，而非剩余额度），底部状态栏显示 `Plan limits`。

#### xAI Grok

用 SuperGrok 账号登录（Account → `xAI`）。用 xAI 的 API Key 登录看不到订阅额度。如果你装的是第三方扩展 `pi-xai-oauth`，用它登录也可以。

#### Antigravity

需先安装 [`pi-antigravity`](https://github.com/Rahularya01/pi-antigravity)（`pi install npm:pi-antigravity`），之后 `/login` 的 `Sign in with an account` 列表里才会出现 `Antigravity`。额度分为三个独立的共享池：Gemini 模型（`5h` 与 `1w`）、Claude 与 GPT 模型（`5h` 与 `1w`）、Gemini 4 Argon（`1w`）。底部状态栏显示当前所用模型对应的额度池：用 Claude 或 GPT-OSS 模型时显示 Claude 与 GPT 池，用 Gemini 4 Argon 时显示 Argon 池，其他 Gemini 模型显示 Gemini 池。额度数据只对 Google AI 付费订阅开放；免费账号在 `/usage` 里显示 `Unsupported`，底部状态栏不显示内容，不会报错。

## 安装

从 npm 安装：

```bash
pi install npm:@specode/pi-subscription-usage
```

从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-subscription-usage
```

从本地目录安装（开发调试）：

```bash
pi install /path/to/pi-subscription-usage
```

## 使用说明

按上面的方法登录，再选一个该提供商的模型，之后：

- 底部状态栏会自动显示当前额度窗口，在每轮对话结束后及每 5 分钟刷新一次（带 5 分钟缓存）。
- 执行 `/usage` 会跳过缓存直接拉取最新数据，显示进度条、重置时间（`MM/DD HH:mm`）及账号信息。

### 使用重置券（OpenAI 与 Codex）

OpenAI 或 Codex 账号里有可用的限额重置券时，`/usage` 会提供使用入口：

- 确认弹窗默认选中 `Cancel (Default)`，必须手动确认才会消耗重置券。
- 提交兑换前，扩展会检查当前模型和账号是否发生变动，并核对运行时令牌是否与 Pi 保存的 OAuth 登录信息一致。
- 在 OpenAI 模式下，重置券作用于服务端定义的账户级窗口，不一定单独清空当前应用的限额。
- 兑换重置券是本扩展唯一的写操作。

## 配置

百分比默认显示剩余额度。如需改为显示已用额度，可在 `~/.pi/agent/subscription-usage.json`（全局）或 `.pi/subscription-usage.json`（受信任项目的局部覆盖）中配置：

```json
{
  "displayMode": "used"
}
```

| 配置值 | 说明 |
| --- | --- |
| `"remaining"` | 显示剩余额度百分比（默认） |
| `"used"` | 显示已用额度百分比 |

修改配置文件后执行 `/reload` 生效。`displayMode` 同时作用于底部状态栏、`/usage` 进度条和状态事件。

## 隐私与安全

- 仅从 Pi 自身的登录注册表读取凭据，不读取浏览器 Cookie 或其他工具的凭据文件（例如 Grok 不会读取 `~/.grok/auth.json`）。
- 仅向各提供商的官方接口发起请求，拒绝自定义代理和自定义 Base URL。
- 令牌不会写入缓存、会话文件、状态栏或报错信息。
- 不修改任何模型请求。
- 部分提供商的用量接口属于未公开接口；若接口变更，扩展会直接报错提示，不会猜测或伪造数据。

## 本地开发

```bash
# 运行测试（需要原生支持 TypeScript 的 Node.js 版本）
npm test

# 检查打包文件列表
npm run pack:check

# 不安装直接加载扩展验证
pi --no-extensions --offline -e ./index.ts --list-models
```

### 主题与状态栏扩展接入

扩展会在 `subscription-usage/status/v1` 事件通道发布结构化状态事件，供自定义主题或状态栏扩展直接渲染额度数据，无需解析状态栏文本。窗口固定按 `5h` -> `1w` -> `1m` -> 其他顺序排列；就绪事件包含 `displayMode`，每个窗口提供 `displayPercent`、`remainingPercent`、`usedPercent` 和 `resetCountdown`。

## 许可证

[MIT](./LICENSE)。改编的第三方源码及许可证信息见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
