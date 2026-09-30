# Pi Subscription Usage

[English](README.md) | [简体中文](README.zh-CN.md)

一个用统一格式展示当前 Pi 账户订阅额度的扩展。

支持以下提供商：

- **OpenAI（ChatGPT 订阅）**：将套餐 `Plan limits` 与当前应用额度分组展示，沿用原有进度条。底部及状态事件默认展示 `Plan limits`，与 ChatGPT 用量页对齐。同时需要在 Pi 登录同一 ChatGPT 账户/工作区的 `openai-codex`，因为 OpenAI 会拒绝 Sign in with ChatGPT 令牌访问 ChatGPT 用量和重置接口；执行一次 `/login openai-codex` 即可，当前模型仍保持 OpenAI（见[稳定性](#稳定性)）。插件用 Codex 后端凭据从 `/wham/usage` 的 `rate_limit` 读取网页套餐窗口及积分余额，并从 `/wham/usage/chatpass/apps` 精确匹配当前应用窗口。两组各自保留百分比与重置时间，不互相冒充。`App Allowance` 是配置的使用上限，不是剩余额度；任一凭据变化都会使缓存失效。不读取浏览器 Cookie。可用账户重置票据显示为 `Account Resets`；明确确认后，通过配套 Codex 账户的重置接口兑换，并非应用专属重置接口。

- **OpenAI Codex**：5 小时与每周额度、模型专属额度，以及需要确认的重置次数兑换。`Resets Left` 只统计重置票据列表中可兑换的票据，不采用用量接口的汇总数。
- **OpenCode Go**：5 小时、每周和每月窗口。
- **Grok**：每周和/或每月额度；只使用 Pi 的 `xai` / `xai-auth` OAuth 凭据，并先验证账户身份。若 weekly `currentPeriod` 存在但省略了 `creditUsagePercent`，按已用 0% 处理（proto3 在周期重置后会省略 0）。统一账单账户仍会探测默认月度接口，但 weekly 窗口已经可展示时，月度探测失败不再让整次查询失败。窗口与其他提供商一样使用 `5h / 1w / 1m` 状态格式。
- **Kimi Coding**：5 小时和每周窗口，以及额度接口返回的会员套餐。

本扩展不实现或修改 Codex Fast 模式，也不会改写模型请求。

## 安装

直接从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-subscription-usage
```

npm 包发布后，也可以这样安装：

```bash
pi install npm:@specode/pi-subscription-usage
```

本地开发时可以安装本地目录：

```bash
pi install /absolute/path/to/pi-subscription-usage
```

Pi package 拥有当前用户的完整系统权限。安装第三方 package 前，请先审查其源码。

## 使用

运行：

```text
/usage
```

每次调用都会跳过缓存并重新查询当前提供商。所有额度窗口都使用统一格式，并以 `MM/DD HH:mm` 显示重置时间。提供商返回账户指标时，这些指标会统一显示在额度窗口之后的独立 `Account` 区域。

Codex 结果会按以下额度域分组：

1. `Shared Across Models`
2. 各模型专属分组
3. `Account`

不同额度域的窗口不会交错。存在邮箱字段时，Codex `Account` 区域会显示从当前 OAuth Token 本地解析出的邮箱。需要刷新时再次运行 `/usage` 即可；命令不会显示刷新、切换提供商或查询所有提供商的菜单。

OpenAI 和 Codex 模式都仅在确认有可兑换重置次数时显示重置菜单。Grok 当前 API 只公开额度窗口和自然重置时间，没有经过验证的手动重置端点或重置次数，因此本扩展不会虚构重置操作。Grok 窗口仍通过与 Codex、OpenCode Go、Kimi 相同的 `/usage` 进度条和状态事件展示。

## 配置

可创建 `~/.pi/agent/subscription-usage.json` 作为全局配置，或在受信任项目中创建 `.pi/subscription-usage.json` 覆盖全局配置：

```json
{
  "displayMode": "used"
}
```

`displayMode` 支持：

- `"remaining"`：显示剩余额度（默认值，保持当前行为）。
- `"used"`：显示已使用额度。

该配置同时作用于底部状态、`/usage` 额度条和结构化状态事件。修改配置文件后运行 `/reload`。

## OpenAI / Codex 重置安全措施

OpenAI 与 Codex 模式都使用 ChatGPT 用量页相同的 `/wham/rate-limit-reset-credits` 和 `/consume` 接口，并以 Codex 账户的后端凭据认证；显示和兑换时都通过 `chatgpt-account-id` 限定为该令牌自身的账户。两种模式都只统计和提供明确存在、可用、套餐支持且未过期的 `codex_rate_limits` 票据，且始终指定具体票据兑换：仅有汇总次数或列表查询失败时，都不会退回由服务端选票的兑换。OpenAI 模式下，票据重置的是服务端定义的账户窗口，**不保证清空当前应用窗口**，确认框会说明这一范围。查询重置次数失败不会隐藏额度；兑换成功会使两种模式的额度缓存失效。

兑换重置次数前，本扩展会：

1. 确认当前 OpenAI 或 Codex 模型及展示额度对应的账户没有变化。
2. 确认运行时令牌与 Pi 通过 `/login` 保存的 OAuth 账户完全一致。OpenAI 模式会检查两套保存的凭据，并在兑换前重新核验应用匹配。
3. 显示即将消耗的重置次数并要求明确确认。`Cancel (Default)` 始终位于第一项；只有主动选择第二项才会继续。
4. 使用唯一请求 ID，并在重试时复用同一个 ID。

## 状态集成

本扩展提供两层状态输出：

- 不含提供商名称或图标的普通 `setStatus` 文本，例如 `5h 99% ↻2h13m · 1w 85% ↻3d4h · 1m 60%`。`↻` 后是距离该窗口重置的倒计时，仅在提供商返回未来的重置时间时显示。底部状态每 5 分钟及每轮 agent 结束后刷新，因此倒计时最多可能滞后约 5 分钟。
- 通过 `subscription-usage/status/v1` 事件发布的结构化窗口数据。

窗口始终按 `5h / 1w / 1m / other` 排序。其他扩展可以直接消费结构化事件，自定义图标、颜色和布局，而不必解析显示文本。就绪事件包含 `displayMode`，每个窗口包含 `displayPercent`、`remainingPercent` 和 `usedPercent`；消费者应展示 `displayPercent`，并在颜色或告警等语义判断中使用明确的剩余/已用字段。提供商返回未来的重置时间时，窗口还包含 `resetCountdown`（例如 `2h13m`），在发布事件时计算，格式和刷新频率与底部状态文本一致；消费者可直接展示，无需自行根据 `resetsAt` 格式化。

## 安全边界

- 额度查询只通过 `ctx.modelRegistry.getProviderAuth()` 解析凭据。
- 账户重置还会通过公开的 `readStoredCredential()` API 读取 Pi 保存的 OAuth 凭据，仅用于确认其与当前运行时账户完全一致。
- Grok 不会读取 `~/.grok/auth.json`，也不会用 API Key 代替订阅 OAuth。
- 凭据不会写入缓存、会话、状态栏或错误消息；缓存键只保存进程内 HMAC 指纹。
- Codex 邮箱仅在本地解析后显示于 `/usage` 账户区域，不会进入底部状态或结构化状态事件。
- 凭据只会发送到对应的官方域名；自定义代理和自定义基础 URL 会被拒绝。
- 账户重置兑换（OpenAI / Codex）是唯一的写操作。只有存在可兑换次数时才会显示，并且始终要求明确确认。

## 开发

要求：

- 当前版本的 Pi。
- 能够直接运行 TypeScript 文件的 Node.js 版本，用于执行测试。

运行测试：

```bash
npm test
```

检查 npm 包内容：

```bash
npm run pack:check
```

不安装、直接加载扩展：

```bash
pi --no-extensions --offline -e ./index.ts --list-models
```

## 稳定性

OpenAI 应用额度也依赖未公开的 ChatGPT 接口。OpenAI 会拒绝 Sign in with ChatGPT 令牌访问这些 ChatGPT 用量和重置接口（HTTP 401），因此必须配套 Codex 登录：用同一账户/工作区执行一次 `/login openai-codex`。它只用于读取用量，当前模型仍可保持 OpenAI。未登录时，可在 https://chatgpt.com/settings/usage 查看用量。账户/工作区不匹配、找不到应用注册或额度窗口时会报告错误，不展示其他账户的额度。`App Allowance` 表示允许应用使用的套餐份额，不是剩余额度百分比。`Source` 明确标注这是 Pi Codex 登录账户内匹配应用的数据；应用 ID 匹配不是对两套令牌身份的独立验签证明。

Codex 重置、Grok 账单和 Kimi 额度依赖未公开的提供商 API，这些 API 可能发生变化。如果 API 调用失败，本扩展只会报告查询错误，不会退回到不受控制的凭据或代理路径。

## 许可证

采用 [MIT](LICENSE) 许可证。改编的第三方源码及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
