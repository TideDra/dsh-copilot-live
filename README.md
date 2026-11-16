# Copilot 实时模型

为 DeepSeek Harness `0.2.2-rc.1` 提供独立的 **github-copilot-live** 模型入口，实时同步当前 GitHub Copilot 账号的在线模型目录、能力参数与分档价格。

## 安装

前提：已安装 `@lujianjun19/dsh-llm-github-copilot`（或已有 `llm-pi-ai/github-copilot` OAuth 登录凭据）。

可直接从 GitHub 安装到你的 DSH profile（例如 `web`）：

```sh
dsh plugin --profile web add https://github.com/TideDra/dsh-copilot-live.git -w
```

或在克隆仓库后按本地目录安装：

```sh
dsh plugin --profile web add /path/to/dsh-copilot-live -w
```

## 使用

1. 保留现有 GitHub Copilot 登录插件并完成登录；本插件复用 `llm-pi-ai/github-copilot` 的凭据，不要求复制令牌。
2. 打开 **设置 → 模型 → 添加模型提供商 → 第三方模型提供商**，选择 **github-copilot-live**，点击卡片内的黑色按钮 **启用 Copilot 实时模型**，完成后关闭添加面板。
3. 在聊天输入区的原生模型选择器内，选择 **github-copilot-live → Gemini 4 Carbon** 或其他在线模型。

**v1.1.0 起安装只声明“可添加”的候选项，不自动激活模型入口、不读取 Copilot 凭据、不启动后台同步。** 只有手动保存提供商配置后才注册实时入口；在模型设置中使用原生“移除”按钮删除该行会注销入口并停止同步，但不退出 Copilot 登录。诊断与价格查询接口均不会替你添加提供商。

当前 DSH 0.2.2-rc.1 的原生编辑器只支持内置适配器 namespace，独立插件的原生“保存”按钮会呈灰色。本插件通过官方 `settings.models.provider-card` 插槽提供自己的黑色 **“启用 Copilot 实时模型”** 按钮，使用相同的 Settings 版本校验与路径保存接口；不要点击上方灰色“保存”。v1.1.2 补齐了 `remote` 父级与 `remote.settings` 子级依赖，解决真实 Cordis 抛出 `cannot get property "remote" without inject` 导致点击无反应的问题。运行时接口在插件激活期间绑定，点击入口完整处理异常、拒绝及 20 秒超时，并合并重复点击，不会无提示卡住。超时不表示已经提交的写入被撤销，请先刷新设置检查是否已添加，再决定是否重试。

官方插槽没有关闭父添加面板的回调，所以成功后可点原生“取消”关闭添加面板，它不会撤销插件已完成的保存。没有修改核心 UI、冒用其他适配器 namespace、隐藏原生 DOM 或模拟点击。

原有 `github-copilot`、默认模型、其他提供商与现有会话配置均不修改。

## 实现

- 通过当前账号原生 Copilot 认证解析真实 API 域名，并调用 `GET /models`，不使用本地目录决定成员资格。
- 每 5 分钟后台检查；模型列表/新请求读取时按 60 秒 TTL 更新；并发刷新合并为一次请求。手动强制刷新可绕过 TTL。
- 从在线目录同步协议、总上下文、输入/输出上限、图片数量/大小、视觉能力及推理档位；已知模型仅借用精确 ID 的原生传输兼容参数。
- 根据 `supported_endpoints` 为模型选择 Chat Completions、Responses 或 Anthropic Messages，保留原生 Copilot 鉴权、请求头和流式转换。
- 新模型的推理枚举完全取自在线能力；没有明确枚举时使用提供商默认，不凭模型名字虚构推理档位。
- 完整兼容 Copilot Chat Completions 模型的推理签名（按官方 CAPI 协议捕获并成对回传 `reasoning_opaque` + `reasoning_text`、兼容 `extra_content.google.thought_signature`、并在已完结的历史轮次按官方策略剥离跨轮思考字段，同时保护工具调用中途的时间上下文或 steer 插话不丢签名）；仅使用公开 provider hooks，不修改 DSH/pi-ai 文件或全局 fetch。
- 过滤禁用策略、隐藏模型（可配置）、非聊天、无工具调用或无流式能力的模型。`unconfigured` 策略标为“需确认条款”，不会擅自修改 GitHub 策略。
- 同一账号刷新失败时保留上次成功目录并显示 stale；切换账号或退出登录后清除原账号目录，防止错误继承可用性。
- 凭据只通过 DSH credential service 读取及原生刷新锁更新；状态、日志和测试产物不包含令牌。只把令牌发送至认证提供的 GitHub Copilot HTTPS 端点。

## 查看各模型价格（v1.2.1）

- 在 **设置 → 模型 → github-copilot-live** 卡片内查看 **Copilot 模型价格**。已添加的提供商默认展开；未添加时可以点“查看各模型价格”作只读预览，不会因此启用提供商。
- 仅列出当前可选的聊天模型（过滤策略禁用、选择器隐藏或不支持的模型），显示默认档和长上下文档的输入、输出、缓存读与缓存写价格。支持“刷新价格”、缓存时间及过期提示。
- 聊天模型选择器的候选菜单项徽标精简显示默认档输入/输出单价（如 `入 $2.00 / 出 $10.00`，省略 `/百万 tokens`）；通过官方 `conversation.input.model.label` 插槽，模型被选中后在输入框触发器与一级菜单当前值中隐藏价格徽标（模型政策警告仍保留显示）。

显示单位为 **USD 等值 / 每百万 tokens**。按官方实现，新 tiered `token_prices` 为每个 `batch_size` token 的 AI credits：乘 `1000000 / batch_size`，再除以 100 得美元。旧 flat 格式还必须先除以 `1e9`；高级请求倍率是另一种旧制计费，不冒充 token 单价。缺省批次按官方约定为 1M，显式无效批次不归一化；缺失/无效价格显示“—/未提供”，不是免费；极小非零价格不显示成零。

[GitHub 官方模型价格表](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)与[AI credits 说明](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing)确认 **1 AI credit = $0.01 USD**。原始编码、字段别名和批次归一化依据[官方 VS Code 实现](https://github.com/microsoft/vscode/blob/b37ee54558593263e8e1a61bd4c102ad82dceefd/extensions/copilot/src/extension/conversation/common/languageModelAccess.ts)。模型费率来自账号在线 API，不硬编码文档促销价格。

**标价不是最终账单。** 套餐额度、缓存、促销、上下文档位及折扣仍会影响计费；API 返回值与官方网页可能不同，插件不会偷偷按网页覆盖接口数据，也不推测差异必然由旧版本 header 引起。保留服务器版本/计费提示，并提供官方参考链接。`context_max`/`max_prompt_tokens` 是该价格档的输入上界，不覆盖模型总上下文，也不做未经证实的分段累进费用估算。

## 配置

插件的所有字段均在 Cordis Config schema 中声明，可通过 DSH 插件配置编辑。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `providers` | `{}` | 用户手动添加的配置；仅 `github-copilot-live` 子项存在时激活入口；此字段可通过原生 Settings 实时保存 |
| `refreshIntervalSeconds` | 300 | 添加后的后台检查间隔 |
| `cacheTtlSeconds` | 60 | 目录缓存 TTL |
| `requestTimeoutMs` | 20000 | 目录请求超时 |
| `streamIdleTimeoutMs` | 300000 | 推理流空闲超时 |
| `apiVersion` | `2026-06-01` | Copilot API 版本 |
| `includeHiddenModels` | false | 包含 API 标为选择器隐藏的聊天模型；仍过滤明确禁用/不兼容模型 |
| `fallbackContextWindow` | 128000 | 未提供容量且无精确本地元数据时的保守回退 |
| `fallbackMaxTokens` | 8192 | 未提供输出上限且无精确本地元数据时的保守回退 |

回退值会在诊断状态中明确标注，不能当作服务器已确认的能力。Copilot 订阅、额度、组织策略和模型条款由 GitHub 控制，目录出现模型不等于付费推理已成功。

## 诊断与测试

通过 DSH 自带 Connection 认证保护的只读诊断：`GET /api/copilot-live/status`。可加 `?model=gemini-4-carbon` 检查 DSH 原生 registry 对该模型解析出的最终参数。`POST /api/copilot-live/refresh` 只重新读取目录，不变更模型政策。

本地开发测试使用当前 DSH 安装已有的库，不修改 profile 包管理文件：

```sh
DSH_RUNTIME_ROOT=/absolute/path/to/dsh-install npm test
DSH_RUNTIME_ROOT=/absolute/path/to/dsh-install npm run probe
```

`probe` 只保存官方模型元数据到开发产物目录，凭据不会进入产物。测试/探测脚本不包含在发行包内。

安装通过 DSH 插件管理器选择本目录；关闭或卸载本插件只移除实时入口，原有提供商和登录记录保持不变。源码和原创同步图标均采用 MIT 许可证。
