# 设计：`X-Agent-Hint` 头上的服务意图 hint

> 状态：v1（2026-10-13）。本文记录已发布插件 `dsh-agent-hints` 的设计：一个仓外 DSH bundle 插件，在每次主请求的 `X-Agent-Hint` HTTP 头（UTF-8 JSON，base64url）上携带结构化服务意图 hint——会话身份、agent 状态、优先级、缓存控制——供服务引擎（部署方的推理网关）解码消费，即"Agent 发信号、引擎认信号"范式。面向使用者的摘要见 [README](../README.zh.md)；本文是设计依据。

## 1. 目标与边界

- **目标**：任一 DSH agent 的每次主请求经 `X-Agent-Hint` 头携带结构化 AgentHint，作为"Agent 发信号、引擎认信号"范式的发送侧第一个动作；接收端（部署方自有推理网关）解码消费。
- **形态**：独立 npm 形态插件 `dsh-agent-hints`（挂载 id `agent-hints`）。插件 = **hint 计算 + DeepSeek chat-completions 传输一体**：注册独立 provider 路由 `deepseek-hint`（结构化实现 harness `LlmAdapter` 契约），与官方 `deepseek-official` 路由并存；部署经 `agent-default-model.provider` 切换，官方 llm-deepseek 插件保持 mounted 作为兜底。零 harness 源码修改、零 harness 运行时依赖（`@deepseek-ai/cordis` 仅类型导入、构建期擦除；运行时服务以结构化鸭子类型触碰）。
- **明确不做（v1）**：
  - `prediction`：需观测统计引擎，后续项；
  - `strict_priority`：由可信控制面注入，本插件永不发送；
  - 异步状态上报的**网关发送**：事件通道已就绪（`src/status.ts` 的 tool/running/finalize），sink 为本地 JSONL 文件（配置 `statusSink` 启用），网关客户端后续替换 `emit()` 接缝；
  - images/files 内容：显式抛错 `UNSUPPORTED_CONTENT`（v1 text-only 子集，不静默降级）。

## 2. 挂点与 wire 形态

**为什么是独立适配器而不是扩展注册表**（对照 harness 源码核实）：官方适配器在其 `request()` 实现内部构造 HTTP 头——没有 header 扩展点、没有 `extraHeaders` 配置；扩展注册表只开放**请求体顶层字段**。仓外插件要按协议把 hint 放进 header，唯一不动 harness 的插件形态路径就是自实现适配器。

**wire 形态**：

```http
POST {baseURL}/chat/completions
authorization: Bearer …
content-type: application/json
x-deepseek-harness-session-id: session-…     ← 身份信号，对齐官方适配器约定
x-agent-hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQi…  ← UTF-8 JSON AgentHint 的 base64url
```

请求体 = 官方同构的 chat-completions 格式（model/messages/tools/thinking/max_tokens…），**不含任何 hint 字段**。对不理解该头的端点，它只是无害的未知头。

**头载荷**（schema 即协议契约）：

```jsonc
{
  "session": {
    "session_id": "session-…",
    "agent_type": "agent",
    "call_index": 7,
    "epoch": 0
    // "parent_session_id" / "derivation": {"relation": "spawn"|"fork", "join": "sync"|"async"} — 仅有血缘的会话携带
  },
  "agent_status": { "state": "running", "state_since_ms": 1760000000000 },
  "priority": { "level": 3, "reason": "user_waiting" },          // 配置项；null 显式省略
  "cache_control": [{ "type": "pin", "range": { "end": 1 } }]    // 配置项；null 显式省略
}
```

**为什么契约成立**（已核实）：harness `LlmAdapter` 抽象契约极薄——唯一必需方法 `stream(options)`；`resolveModel`/`providerInfo`/`prepareCall` 有默认实现需结构化补齐；`GenerateOptions` 首参直接携带 `sessionId`/`purpose`，发射规则在适配器内同步可见；运行时对适配器只做方法调用（duck typing），插件以**结构化实现**满足契约、零 runtime import。

## 3. 字段映射（协议字段 → DSH 运行时事实）

| AgentHint 字段 | v1 来源 | 说明 |
| --- | --- | --- |
| `session.session_id` | `options.sessionId` | agent loop 盖章的会话身份 |
| `session.agent_type` | 配置 `agentType`，默认 `agent` | |
| `session.call_index` | `deriveServingFacts`：会话日志 `step/start` 事件计数（含当前步——loop 在派发前 append；辅助调用不进 loop step 不计数） | **重启安全**：restore 重放日志，计数续接 |
| `session.epoch` | `deriveServingFacts`：会话日志 `compaction/end` 事件计数 | 同上，重启安全 |
| `session.parent_session_id` / `derivation.relation` / `derivation.join` | `ctx.get('sessions').get(sessionId).header`：`parentSession` 存在则携带；`origin === 'subagent'` → `spawn`，否则 → `fork`；`join` 来自父会话委托工具调用的 `run_in_background`（firehose 跟踪：true→`async`，否则 `sync`） | 会话不存在/服务缺失则省略（降级不失败）；`fork_point` 需消息下标映射，不发射 |
| `agent_status.state` / `state_since_ms` | 请求时刻恒 `running`（请求仅在生成时发出）；`state_since_ms` = 日志中最近一次 `tool/result` 事件时刻，无则取请求时刻 | |
| `priority` | 配置，默认 `{level: 3, reason: "user_waiting"}`；`null` 显式省略 | |
| `cache_control` | 配置，默认 `[{type: "pin", range: {end: 1}}]`（pin 系统提示词）；`null` 显式省略 | |
| `prediction` / `strict_priority` | **不发送** | 见 §1 边界 |

**发射规则**：仅主请求发射——`purpose` 为 `compaction` / `session-title` 的辅助调用、无 `sessionId` 的请求不构造 hint、不加头。身份信号与官方适配器对齐：`x-deepseek-harness-session-id`（有 sessionId 时）与 `x-deepseek-harness-compact: 1`（compaction 时）照发。

**失败语义**：配置在 apply 阶段严格校验（非法即组合失败，带字段路径），请求期 hint 构造无异常路径；会话血缘读取走可选降级；凭据缺失在请求期抛 `MISSING_CREDENTIAL` 语义错误（进 harness 重试/错误面）。

## 4. 插件架构与运行时触碰面

```text
apply(ctx, config)
├── normalizeConfig(config)              # 严格校验：baseURL/apiKeyEnv 必填，非法即组合失败
├── firehose 监听（常驻）                 # tool/call: 委托工具 → delegationJoin(run_in_background→sync/async)
├── statusSink 配置时：StatusObserver     # 带外状态通道（src/status.ts）
│   ├── tool/call → {state:'tool', reason:'await_tool', tools:[全部未决]}
│   ├── tool/result → 未决清空才报 {state:'running'}（并行工具等最后一个）
│   ├── turn/end(completed) → {state:'finalize'}   # 一次性 headless 任务完成判定；不映射 DSH idle
│   └── 子会话首现 → 绑定 child_session_id 到父会话最老未决委托
└── ctx.llm.registerAdapter(['deepseek-hint'], HintedDeepSeekAdapter)
    ├── stream(options)                  # hint 构造 → header 注入 → fetch → SSE → StreamChunk
    │   ├── deriveServingFacts(session)  # 从 ownEvents 派生 call_index/epoch/runningSinceMs（重启安全）
    │   ├── serializeRequest()           # 官方同构：system/assistant(reasoning_content, tool_calls)/role:'tool' 展开/""非 null 规则
    │   ├── X-Agent-Hint: base64url(JSON)
    │   ├── fetch + parseSse()           # 手写 RFC-lite SSE 解码（零 npm 依赖），[DONE] 终止，EOF 报 STREAM_CLOSED
    │   ├── translate()                  # block-start/delta/block-end 延迟到 [DONE]、usage 缓存命中拆分、finish_reason 映射
    │   └── 错误码映射                     # 401/403→AUTH、429→RATE_LIMIT、5xx→SERVER、400→INVALID_REQUEST（harness 重试层按码路由）
    ├── prepareCall/resolveModel         # 模型目录（contextWindow 供 compaction 决策）
    └── providerRetryPolicy → undefined  # 重试归 harness llm-retry 层（默认 normal/5），适配器不内置重试
```

- **llm 服务**：`ctx.llm.registerAdapter` 结构化触碰；插件不导出 schemastery Config，loader 把 patch 行 config 原样传给 `apply` 第二参。**部署旋钮**：`baseURL`/`apiKeyEnv` 必配；指向自有网关时必须提供 `models` 目录（`maxTokens`/`contextWindow` 与网关实际限制一致，默认目录对齐官方 deepseek 家族 256k/1M）。
- **凭据**：credentials 服务优先（home `.credentials.yaml` / Models 页写入），`apiKeyEnv` 环境变量回退——与官方适配器同序。
- **sessions 服务**：经 `ctx.get('sessions')` 可选读取（cordis inject 纪律：未注入服务的属性访问抛错；`ctx.get` 是可选 peer 接缝）。
- **事件**：`ctx.on('session/event', …)` fiber 声明周期自动清理。

## 5. 验证设计

hint 在 HTTP 头里、模型不可见、session log 不记录，**wire 证据是唯一可靠的功能验证**：

- **单测**（`node --test`，运行于提交的 built JS，28 项）：hint 构造/编码（base64url 契约）、serialize 各消息形状与 image 拒绝、thinking 解析、SSE 解码（跨 chunk/CRLF/注释行/缺 [DONE]）、translate（delta 流转/延迟终止/usage 拆分/EMPTY_RESPONSE）、HTTP 错误码映射、stream 发射规则（fake fetch：主请求加头、辅助/无会话不加、body 无 hint 字段、call_index 递增、血缘解析）、resolveModel 目录与兜底。
- **keyless wire e2e（`e2e/run.sh`）**：本地 SSE 捕获 stub（`e2e/stub-server.mjs`，两阶段剧本：`e2e_probe` 回显工具调用 → 终答；工具由 `e2e/fixture-tool.mjs` 经 patch 源路径挂载）+ patch 行 config 把适配器 `baseURL` 指向 stub、`apiKeyEnv` 指向哑环境变量、`statusSink` 指向 scratch 文件，模型路由切 `deepseek-hint` 跑一轮工具往返 → `e2e/capture-check.mjs` 断言：恰 2 个主请求携带 `X-Agent-Hint`、base64url 解码后逐项符合 schema（**call_index 1→2 即 step/start 派生的端到端验证**）、`session_id` 与 `x-deepseek-harness-session-id` 头一致、**body 无任何 hint 字段**、辅助请求（session-title）无 hint 头；状态 sink 断言工作会话 `tool → running → finalize` 序列与 tools[]/call_id 形状。
- **真机门禁**：`deepseek-hint` 路由指向真实网关（`baseURL` 配置 + `apiKeyEnv` 凭据），真实任务 exit 0 + 独立读回产物。已在真实 OpenAI 兼容网关验证（网关前挂本地记录转发代理）：主线请求 hint 端到端到达、真实工具往返 exit 0、产物独立读回。session-title 辅助调用（`thinking: {type: "disabled"}`）被网关背后的始终思考模型拒绝、harness 容忍该失败——见 §6。

## 6. 已知边界与后续项

- **协议子集**：v1 仅 chat-completions——text+tools+thinking+usage+abort；images/files 显式拒绝，messages 协议、图片表示为后续项——子集需手动跟进官方适配器演进（部署目标是自有网关，子集可控）。
- **路由并存**：`deepseek-hint` 与官方 `deepseek-official` 并存，误切 provider 会静默失去 hint——e2e wire 断言兜底。
- `call_index`/`epoch`/`runningSinceMs` 派生自会话日志（restore 重放），重启续接；依赖 harness 事件语义（`step/start` 前置于派发、辅助调用不进 loop step），演进需跟进。
- `derivation.join` 取父会话最近一次委托调用的 `run_in_background`——并行委托共享最新值（可接受近似）；子会话 `child_session_id` 绑定为父会话最老未决委托（FIFO）。
- `finalize` 以 `turn/end(completed)` 为完成判定（一次性 headless 任务语义）；交互式 profile 的会话级终点需另行判定。状态通道 sink 为本地 JSONL，网关客户端替换 `emit()` 接缝后接管重试/顺序语义。
- `prediction` 待统计引擎；`fork_point`、handoff/suspend 框架触发保持不发射。
- **始终思考模型的辅助调用**：适配器遵循官方约定，session-title 调用固定 `thinking: {type: "disabled"}`。以始终思考模型为后端的网关会拒绝该形态；harness 容忍该失败（任务不受影响、无生成标题）。支持网关特有思考档位词表（如仅 `low`/`high`/`max`）属适配器层策略变更——后续项。
