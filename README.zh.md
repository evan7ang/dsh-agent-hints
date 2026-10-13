# dsh-agent-hints

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的逐请求服务意图 hint 插件：每次主请求在 **`X-Agent-Hint` HTTP 头**（UTF-8 JSON，base64url）上携带结构化 AgentHint——会话身份、agent 状态、优先级、缓存控制——让推理网关等服务引擎能够观察并响应 agent 的当前状态，即"Agent 发信号、引擎认信号"范式。

插件注册**独立 provider 路由 `deepseek-hint`**，由自实现的 chat-completions 适配器承载。官方 `deepseek-official` 路由保持 mounted 并作为兜底；部署经 `agent-default-model.provider` 切换。零 harness 源码修改、零 harness 运行时依赖（运行时服务仅以结构化鸭子类型触碰）。

[English](README.md) | 中文 · 设计记录：[docs/design.zh.md](docs/design.zh.md)（[English](docs/design.md)）

## 工作原理

harness `LlmAdapter` 契约极薄（仅 `stream()` 必需），而官方适配器在其 `request()` 实现内部构造 HTTP 头、无扩展点。因此本插件自实现适配器契约并追加一个头：

```http
POST {baseURL}/chat/completions
authorization: Bearer …
content-type: application/json
x-deepseek-harness-session-id: session-…          ← 身份信号，对齐官方适配器约定
x-agent-hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQi…   ← UTF-8 JSON AgentHint 的 base64url
```

请求体保持 provider 原生 chat-completions 格式，**永不携带 hint 字段**。对不理解该头的端点，它只是无害的未知头。

与静态头注入方案（如包装 `fetch` 固定改写 `user-agent`）不同：hint 值**逐请求动态派生**自会话的持久化事件日志（调用序号、compaction epoch、最近一次工具结果时刻）与会话血缘——没有可静态配置的值。

### 发射规则

- **仅主请求发射**：辅助调用（`compaction` / `session-title` purpose）与无会话身份的请求不加头。
- `strict_priority` **永不发送**（可信控制面字段）。
- `prediction` v1 不发送（需要观测统计引擎）。
- 身份信号与官方适配器对齐：`x-deepseek-harness-session-id`（有会话 id 时）与 `x-deepseek-harness-compact: 1`（compaction 时）照发。

### `X-Agent-Hint` 载荷

```jsonc
{
  "session": {
    "session_id": "session-…",
    "agent_type": "agent",
    "call_index": 7,          // 派生自会话持久化日志（step/start 计数）；重启安全
    "epoch": 0                // 派生自 compaction/end 计数；重启安全
    // "parent_session_id" / "derivation": {"relation": "spawn"|"fork", "join": "sync"|"async"} — 仅有血缘的会话携带
  },
  "agent_status": { "state": "running", "state_since_ms": 1760000000000 },
  "priority": { "level": 3, "reason": "user_waiting" },          // 配置项；null 省略
  "cache_control": [{ "type": "pin", "range": { "end": 1 } }]    // 配置项；null 省略
}
```

带外状态事件（每个工作会话 `tool` → `running` → `finalize`，含等待中的工具名与 call id）上报到可选的 `statusSink`（本地 JSONL 文件）；`emit()` 接缝供网关客户端接管。

## 安装

本仓**随源提交构建产物**（`lib/`），从 GitHub 安装**无需放行构建脚本**：

```sh
dsh plugin add github:evan7ang/dsh-agent-hints
```

可固定 commit：`dsh plugin add github:evan7ang/dsh-agent-hints#<sha>`。npm 包（`dsh plugin add dsh-agent-hints`）已列入计划、暂未发布。

## 配置与部署

插件在指向上游之前处于惰性状态。在 profile 的 `cordis.patch.yml` 里按行 id 覆盖配置（后层替换整行 `config`，需要的键要全部重述）：

```yaml
- id: agent-hints
  config:
    baseURL: https://your-gateway.example.com
    apiKeyEnv: MY_GATEWAY_KEY
```

再切换模型路由：

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: deepseek-hint
  model: deepseek-flash
```

API key 逐请求解析：credentials 服务优先（`$DSH_HOME/.credentials.yaml` / Models 页写入），其次解析 `apiKeyEnv` 指定的环境变量——与官方适配器同序。

### 配置参考

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseURL` | string | —（必填） | 上游地址基座；每次请求 POST 到 `${baseURL}/chat/completions` |
| `apiKeyEnv` | string | —（必填） | 逐请求解析的环境变量名 |
| `agentType` | string | `agent` | 上报为 `session.agent_type` |
| `priority` | `{level, reason}` 或 `null` | `{level: 3, reason: "user_waiting"}` | 软优先级；`null` 显式省略 |
| `cacheControl` | 数组或 `null` | `[{type: "pin", range: {end: 1}}]` | 缓存控制条目；`null` 显式省略 |
| `thinking` | `"enabled"` / `"disabled"` | enabled | `disabled` 将所有会话请求的 thinking 限制为 `off` |
| `reasoningEffort` | `"off"/"low"/"high"/"max"` | `high` | 请求未携带时的默认推理力度 |
| `models` | `{id, name, contextWindow, maxTokens}[]` | DeepSeek-V4 家族目录 | `resolveModel` 的咨询模型目录；**指向自有网关时必须提供真实限额**（供 compaction 决策使用） |
| `defaultContextWindow` | 正整数 | `1000000` | 目录外模型假定的上下文窗口 |
| `defaultMaxTokens` | 正整数 | `256000` | 调用方缺省时物化的单请求输出上限 |
| `statusSink` | string | 未设（通道关闭） | 带外状态事件的本地 JSONL 路径 |
| `subagentToolNames` | string[] | `["subagent"]` | 视为子 agent 委派的工具名（用于 `derivation.join` 与状态命名） |

配置在装载阶段严格校验，非法即组合失败并带字段路径——请求期 hint 构造没有失败路径。

## 已知边界（v1）

- 仅 chat-completions wire；子集：text + tools + thinking + usage + abort。图片/文件内容显式拒绝（`UNSUPPORTED_CONTENT`），不静默降级。
- 协议子集需手动跟进官方适配器演进（部署目标是自有网关，子集可控）。
- `call_index`/`epoch`/`state_since_ms` 派生自会话事件日志，依赖 harness 事件语义（`step/start` 前置于派发；辅助调用不进 loop step 计数）。
- `derivation.join` 取父会话最近一次委托工具调用——并行委托共享最新值（可接受近似）。
- 切回 `deepseek-official` 路由会静默失去 hint；下列 e2e wire 断言是兜底。

## 开发

```sh
npm install
npm run build        # src/ → lib/（构建产物随源提交）
npm test             # node --test 运行于构建产物
e2e/run.sh           # keyless wire e2e：本地 SSE 捕获 stub + hinted 路由 + 报文断言
```

e2e 的 `dsh` 运行时解析顺序：`DSH_BIN` > `PATH` > deepseek-harness checkout（`DSH_CHECKOUT` 或兄弟目录）。

## License

[Apache-2.0](LICENSE)
