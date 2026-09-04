# Pi Subscription Usage

[English](README.md) | [简体中文](README.zh-CN.md)

一个用统一格式展示当前 Pi 账户订阅额度的扩展。

支持以下提供商：

- **OpenAI Codex**：5 小时与每周额度、模型专属额度，以及需要确认的重置次数兑换。
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

只有当 Codex 返回可兑换的重置次数时，才会显示重置菜单。Grok 当前 API 只公开额度窗口和自然重置时间，没有经过验证的手动重置端点或重置次数，因此本扩展不会虚构重置操作。Grok 窗口仍通过与 Codex、OpenCode Go、Kimi 相同的 `/usage` 进度条和状态事件展示。

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

## Codex 重置安全措施

兑换 Codex 重置次数前，本扩展会：

1. 确认当前模型仍在使用 Codex。
2. 确认运行时令牌与 Pi 通过 `/login` 保存的 OAuth 账户完全一致。
3. 显示即将消耗的重置次数并要求明确确认。`Cancel (Default)` 始终位于第一项；只有主动选择第二项才会继续。
4. 使用唯一请求 ID，并在重试时复用同一个 ID。

## 状态集成

本扩展提供两层状态输出：

- 不含提供商名称或图标的普通 `setStatus` 文本，例如 `5h 99% · 1w 85% · 1m 60%`。
- 通过 `subscription-usage/status/v1` 事件发布的结构化窗口数据。

窗口始终按 `5h / 1w / 1m / other` 排序。其他扩展可以直接消费结构化事件，自定义图标、颜色和布局，而不必解析显示文本。就绪事件包含 `displayMode`，每个窗口包含 `displayPercent`、`remainingPercent` 和 `usedPercent`；消费者应展示 `displayPercent`，并在颜色或告警等语义判断中使用明确的剩余/已用字段。

## 安全边界

- 额度查询只通过 `ctx.modelRegistry.getProviderAuth()` 解析凭据。
- Codex 重置还会通过公开的 `readStoredCredential()` API 读取 Pi 保存的 OAuth 凭据，仅用于确认其与当前运行时账户完全一致。
- Grok 不会读取 `~/.grok/auth.json`，也不会用 API Key 代替订阅 OAuth。
- 凭据不会写入缓存、会话、状态栏或错误消息；缓存键只保存进程内 HMAC 指纹。
- Codex 邮箱仅在本地解析后显示于 `/usage` 账户区域，不会进入底部状态或结构化状态事件。
- 凭据只会发送到对应的官方域名；自定义代理和自定义基础 URL 会被拒绝。
- Codex 重置是唯一的写操作。只有存在可兑换次数时才会显示，并且始终要求明确确认。

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

Codex 重置、Grok 账单和 Kimi 额度依赖未公开的提供商 API，这些 API 可能发生变化。如果 API 调用失败，本扩展只会报告查询错误，不会退回到不受控制的凭据或代理路径。

## 许可证

采用 [MIT](LICENSE) 许可证。改编的第三方源码及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
