# pi-subscription-usage

[English](./README.md) | [简体中文](./README.zh-CN.md)

在 [Pi](https://github.com/earendil-works/pi-mono) 终端底部状态栏与 `/usage` 面板中，统一查看当前订阅账号的实时额度——支持 OpenAI (ChatGPT)、OpenAI Codex、OpenCode Go、xAI Grok、Kimi Coding 和 Antigravity。

- **多平台统一视图**：以一致的进度条和 `MM/DD HH:mm` 重置时间展示 5 小时、每周、每月及模型专属额度窗口。
- **底部栏实时倒计时**：状态栏自动显示紧凑摘要（如 `5h 99% ↻2h13m · 1w 85% ↻3d4h`），每轮对话后及每 5 分钟自动刷新。
- **安全的重置券兑换**：支持查看并兑换 OpenAI / Codex 官方额度重置次数，内置严格的账号核验与二次确认。
- **零凭据外泄风险**：仅在内存中通过 Pi 官方接口读取 OAuth 凭据，不读取浏览器 Cookie，也不改写任何模型请求。

---

## 前置依赖

- 已安装 [Pi](https://github.com/earendil-works/pi-mono)，并通过 `/login` 登录以下任一支持的订阅账号：

| 提供商 | 需要在 Pi 登录的凭据 | 展示的额度窗口 | 手动重置额度 |
| --- | --- | --- | --- |
| **OpenAI (ChatGPT)** | `openai` **以及** `openai-codex`（同一账号/工作区）¹ | 套餐总限额 (`Plan limits`) + 当前应用限额 | 支持 (`Account Resets`) |
| **OpenAI Codex** | `openai-codex` | `5h`、`1w`、各模型独立窗口 | 支持 (`Resets Left`) |
| **OpenCode Go** | `opencode` | `5h`、`1w`、`1m` | — |
| **xAI Grok** | `xai` / `xai-auth` | `1w` 和/或 `1m` | — |
| **Kimi Coding** | `kimi` | `5h`、`1w`、会员套餐等级 | — |
| **Antigravity** | `antigravity` | `5h` + `1w` (Gemini 系列), `5h` + `1w` (Claude/GPT 系列), `1w` (Argon 系列) | — |

> ¹ **为什么 OpenAI 模式需要执行一次 `/login openai-codex`？** OpenAI 的用量与重置接口会拒绝 `Sign in with ChatGPT` 令牌（返回 `HTTP 401`）。用同一个 ChatGPT 账号/工作区执行一次 `/login openai-codex` 后，插件即可借用该凭据读取用量，日常对话模型仍可保持为 `openai`。

---

## 安装

从 npm 安装：

```bash
pi install npm:@specode/pi-subscription-usage
```

或直接从 GitHub 安装：

```bash
pi install git:github.com/specode/pi-subscription-usage
```

本地开发调试：

```bash
pi install /absolute/path/to/pi-subscription-usage
```

> **提示**：Pi 扩展包拥有当前用户的系统权限，安装第三方包前建议先审阅源码。

---

## 快速开始

1. 确保已在 Pi 中通过 `/login` 登录对应订阅账号。
2. 随时输入以下命令查看实时额度详情：

```text
/usage
```

每次执行 `/usage` 都会跳过本地缓存，向当前提供商发起实时查询：

- **底部状态栏**会自动展示当前模型的额度概览（例如 `5h 99% ↻2h13m · 1w 85% ↻3d4h`）。
- **兑换重置次数**：当检测到 OpenAI 或 Codex 账号下有可用重置票据时，`/usage` 会出现重置选项；确认框默认选中 `Cancel (Default)`，防止误触。

---

## 使用与配置

### 切换显示模式（剩余额度 vs 已用额度）

默认显示**剩余额度**百分比。若希望显示**已用额度**，可创建全局配置 `~/.pi/agent/subscription-usage.json`，或在受信任项目中创建 `.pi/subscription-usage.json` 覆盖：

```json
{
  "displayMode": "used"
}
```

| 配置值 | 说明 |
| --- | --- |
| `"remaining"` | 显示剩余额度百分比（默认） |
| `"used"` | 显示已消耗额度百分比 |

修改后执行 `/reload` 生效。该配置同时作用于底部状态栏、`/usage` 面板以及结构化状态事件。

### 各平台额度展示说明

- **OpenAI (ChatGPT)**：将网页端套餐限额（`Plan limits`）与当前应用限额分组展示（`App Allowance` 表示分配给该应用的配额上限比例，而非剩余百分比）。底部状态栏默认展示 `Plan limits`，与 ChatGPT 网页用量页保持一致。
- **OpenAI Codex**：严格按 `Shared Across Models`（跨模型共享）→ 各模型专属分组 → `Account`（含本地从 OAuth Token 解析出的邮箱）顺序排列，不同域的窗口绝不混排。
- **xAI Grok**：使用统一的 `5h / 1w / 1m` 格式。每周重置后若 proto3 省略了为 0 的 `creditUsagePercent`，会正确按已用 `0%` 处理；当周额度已可正常展示时，月度探测失败不会中断整体展示。
- **Antigravity**：自动划分为三个独立额度池：**Gemini Models**（Gemini Flash 与 Pro 的 5 小时与每周限额）、**Claude and GPT models**（Claude Opus/Sonnet 与 GPT-OSS 的 5 小时与每周限额）以及 **Gemini 4 Argon**（Argon 专属每周限额）。底部状态栏按当前模型 id 选择额度池（`claude`、`gpt-oss` 或 `argon`）；无法识别时，若存在 Gemini 池则显示该池。

---

## 设计思路与安全边界

### OpenAI / Codex 额度重置安全机制

兑换重置票据是本扩展唯一的写操作。OpenAI 与 Codex 模式均通过 Codex 后端凭据调用与网页端一致的 `/wham/rate-limit-reset-credits` 和 `/consume` 接口，并通过 `chatgpt-account-id` 严格绑定当前令牌所属账户：

1. **只认明确可用的票据**：仅统计和兑换列表中明确存在、可用、当前套餐支持且未过期的 `codex_rate_limits` 票据；若仅有汇总数字或列表查询失败，绝不回退为由服务端盲选兑换。
2. **兑换前双重核验**：兑换前会再次确认当前激活模型与账号未发生变化，并通过 `readStoredCredential()` 核对运行时令牌与 Pi `/login` 保存的凭据完全一致（OpenAI 模式还会重新核验应用注册匹配）。
3. **明确作用范围与幂等重试**：OpenAI 模式下，确认弹窗会明确提示票据重置的是服务端定义的账户级窗口（不保证清空当前独立应用窗口）。请求携带唯一 ID 并在重试时复用，兑换成功后自动清空双端缓存。

### 状态事件总线（供其他扩展集成）

除输出无图标的纯文本状态栏（`setStatus`）外，扩展还会发布 `subscription-usage/status/v1` 结构化事件，方便主题或状态栏插件自定义图标、颜色与布局，无需正则解析文本：

- 窗口固定按 `5h` → `1w` → `1m` → `other` 排序。
- 就绪事件包含 `displayMode`，每个窗口同时提供 `displayPercent`、`remainingPercent`、`usedPercent` 以及预先格式化好的 `resetCountdown`（如 `2h13m`）。

### 安全与稳定性说明

- **仅限官方直连**：仅通过 `ctx.modelRegistry.getProviderAuth()` 解析凭据并发送至官方域名，拒绝任何自定义代理或自定义 Base URL。
- **严禁跨路径读取**：Grok 仅使用 Pi 的 OAuth 凭据，绝不读取 `~/.grok/auth.json`，也不接受用 API Key 替代订阅登录。
- **凭据不落盘**：Token 不会写入缓存文件、会话记录、状态栏或报错信息；内存缓存键仅保存进程内 HMAC 指纹。
- **未公开接口容错**：OpenAI 应用用量、Codex 重置、Grok 账单和 Kimi 用量均依赖各厂商未公开的内部接口。若遇到账号/工作区不匹配或接口变更，插件会直接报告错误，绝不冒用其他账号数据。

---

## 本地开发

```bash
# 运行测试套件（需支持直接运行 TypeScript 的 Node.js 版本）
npm test

# 检查 npm 打包文件列表
npm run pack:check

# 免安装直接加载验证
pi --no-extensions --offline -e ./index.ts --list-models
```

## 许可证

采用 [MIT](./LICENSE) 许可证。改编的第三方源码及许可证声明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
