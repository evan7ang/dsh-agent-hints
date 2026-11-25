# 四类字段取值逻辑与端到端验证说明

> 状态：2026-11-05。适用范围：`session`、`agent_status`、`priority`、`cache_control` 四类 AgentHint 字段在 DSH 插件中的取值与发送实现，以及对应的字段级端到端验证。
>
> 规范依据：`docs/handoffs/` 三份文档（四值状态、二值 priority、cache 实现指南）；设计记录见 [20261104-01-simplified-scenario-fields](20261104-01-simplified-scenario-fields.md)。实现位置：`src/hint.ts`（取值派生与构造）、`src/cache.ts`（cache 纯函数）、`src/status.ts`（带外事件）、`src/config.ts`（配置归一化）、`src/adapter.ts`（发送）、`src/index.ts`（接线）。

## 1. 通道与发射规则

| 项目 | 规则 |
| --- | --- |
| 传输 | `X-Agent-Hint` HTTP 头，UTF-8 JSON → base64url（无 padding） |
| 发射范围 | 仅**主请求**：`options.sessionId` 存在且 `options.purpose` 为空 |
| 辅助请求 | `compaction` / `session-title` 不带任何 hint |
| 无会话身份 | 不带 hint |
| 请求体 | 永远不携带 hint 字段（header-only 协议） |
| `strict_priority` | 永不发送（可信控制面字段） |
| 状态事件通道 | 配置 `statusSink`（JSONL 文件）和/或 `statusEndpoint`/`statusAuto`（HTTP）时激活；两个 sink 按同一发射顺序各发一份 |

## 2. `session`

| 子字段 | 取值逻辑 | 发送条件 |
| --- | --- | --- |
| `session_id` | `options.sessionId`（agent loop 盖章，跨轮稳定） | 恒有 |
| `agent_type` | 配置 `agentType`，默认 `agent` | 恒有 |
| `call_index` | 会话日志 `step/start` 计数（含当前 in-flight，从 1 开始）；无 sessions 服务时退回进程内序号 | 恒有 |
| `epoch` | 会话日志 `compaction/end` 计数；压缩重写后递增 | 恒有 |
| `parent_session_id` | 会话 header 的 `parentSession`；根会话省略 | 仅有父会话 |
| `derivation.relation` | `header.origin === 'subagent'` → `spawn`，其余 → `fork` | 仅有父会话 |
| `derivation.join` | 父会话最近一次委托工具调用的 `run_in_background`：`true` → `async`，否则 `sync`（协议默认） | 仅有父会话 |
| `derivation.fork_point` | 不发射（设计声明） | 永不 |

- **发送时机**：每个主请求；全部派生自持久日志与 header 血缘，重启续接（restored session 重放日志）。
- `join` 的已知近似：并行委托共享父会话最新值（协议 join 是 per-derivation 语义）。

## 3. `agent_status`

### 3.1 请求 header（仅 `state` + `state_since_ms` 两个键）

| 状态 | 判定（会话日志派生） | `state_since_ms` |
| --- | --- | --- |
| `pause` | 存在未配对的 `tool/call`（按 `callId` 与 `tool/result` 的 `toolCallId` 配对；**任何**工具调用都算等待） | 本次暂停段起点：未决集由空变非空的时刻；并行调用部分结算不漂移 |
| `resume` | 未决集最近一次清空（或 turn 边界，取较晚者）之后的首个 `step/start` 恰为当前 in-flight 请求 | 放行时刻（清空未决集的那次 `tool/result`） |
| `running` | 其余（默认；`resume` 只报一条，第二个请求起回 `running`） | `max(最近 turn/start, 最近放行)`，两者都无则请求时刻 |

- `finalize` **不上 header**：DSH 跑完一轮没有收尾请求，且契约要求下一轮首请求回到 `running`；`finalize` 由 `turn/end(completed)` 事件承载。
- 状态优先级：未决工具存在时 `pause` 优先于 `resume`。
- `resume` 一次性：首个请求消费后，后续请求（同一 turn 内）为 `running`。

### 3.2 带外状态事件（词表 `running | pause | finalize`）

| 触发 | 事件 |
| --- | --- |
| 任意 `tool/call` | `{state:"pause", state_since_ms:暂停段起点, reason:"await_tool", tools:[全部未决]}`；并行时每次重报全量 |
| 未决集最后一次 `tool/result` | `{state:"running", state_since_ms:放行时刻}` |
| 任意 `turn/end` | 清空该会话未决集并关闭 `resume` 窗口 |
| `turn/end(completed)` | 追加 `{state:"finalize", state_since_ms:turn 结束时刻}` |
| 子会话首次出现在 firehose | 把 `child_session_id` 绑定到父会话最老未绑定的 `agent:<tool>` 未决项，并重报一次 `pause` |

- 子代理委托的工具名显示为 `agent:<toolName>`。
- 事件词表不含 `resume`（请求域概念）；放行以 `running` + 新 `state_since_ms` 表达。

### 3.3 发送时机

| 通道 | 时机 |
| --- | --- |
| header | 每个主请求 |
| 事件 | 状态变化时；仅在配置任一 sink 时激活。JSONL 文件单次重试后告警；HTTP sink 单实例串行队列保序，失败按 200/400/800ms 退避重试（5s 超时），耗尽后告警丢弃且不阻塞后续事件 |

## 4. `priority`

| 条件 | `level` | `reason` |
| --- | --- | --- |
| 未配置（`dynamic`）且为 **turn 开局请求**：最近 `turn/start` 后首个 `step/start`；日志无 turn 事件时退化为 `call_index === 1` | 3 | `user_waiting` |
| 未配置且其余请求（自驱续接、工具放行后的 `resume`、压缩后续接） | 1 | `critical_path` |
| 显式静态配置 `{level, reason}` | `level ≥ 3 → 3`，否则 `1`（组合期折叠） | 保留原 `reason` |
| `null`（`omit`） | 字段省略 | — |

- **发送时机**：每个主请求（`omit` 除外），无抑制。
- 工具放行是机器事件、不是用户介入，`resume` 请求不提升优先级；工具门与人工审批门不可区分，审批恢复加成未实现。

## 5. `cache_control`

| 项目 | 规则 |
| --- | --- |
| 形状 | 单条 `{type:"ephemeral", ttl_s, range:{end, unit:"message"}}` |
| `range.end` | 本次实际发出的 wire 消息条数（含 system、含 tool-result 展开）= `body.messages.length` |
| `range.unit` | 仅 `message` |
| `ttl_s`（动态） | `clamp(round(gap × 2), 60, 3600)`；`gap` = 当前 `step/start` − 上一 `step/end`（秒）；无样本回退 300s（→ TTL 600） |
| 前缀门槛 | 前缀 token 估算 < 128 → 不发。估算：CJK/全角字符 1 token/字，其余 `ceil(字符数/4)` |
| 压缩抑制 | 上次响应结束以来发生过 `compaction/end`（步间压缩或步内溢出重试）→ 当轮不发 |
| 模型/工具集抑制 | 签名（model + 排序后的工具名集合）与上一主请求不同 → 当轮不发；`call_index > 1` 且签名未知（新进程，如 `--session-id` 复用会话）→ 保守跳过一轮；`call_index === 1` 视为稳定 |
| 静态配置 | 逐字发送（仅 `ephemeral`、显式 `ttl_s`、至多一条）；仍受压缩/签名抑制，不套用 128 token 门槛 |
| `null`（`omit`） | 字段省略 |
| 跨会话 fork | 不抑制（新会话输入即真实前缀） |

- **发送时机**：每个主请求，除上述抑制命中轮次。

## 6. 信号来源与重启安全

| 派生量 | 来源事件 | 用途 |
| --- | --- | --- |
| `call_index` | `step/start` 计数（含 in-flight） | `session.call_index`、签名保守判定 |
| `epoch` | `compaction/end` 计数 | `session.epoch` |
| 未决集 / 暂停段起点 | `tool/call` + `tool/result`（按 callId 配对） | `agent_status` pause、状态事件 |
| 放行时刻 | 未决集清空的那次 `tool/result` | `resume`、`running` 起点 |
| `turnOpening` | 最近 `turn/start` 后的首个 `step/start` | `priority` 动态二值 |
| `intervalMs` | 当前 `step/start` − 上一 `step/end` | cache TTL |
| `afterCompaction` | `compaction/end` 晚于上一响应结束（`step/end`） | cache 压缩抑制 |

- 以上全部来自 `Session.ownEvents()` 持久日志，恢复会话重放日志，**重启续接**。
- 唯一进程内状态：cache 的模型/工具签名（重启后未知 → 保守跳过一轮）与基础设施缺失时的 `call_index` 兜底序号。

## 7. 端到端验证

### 7.1 运行方式

```bash
npm run typecheck && npm run build && npm test   # 68 项单测（运行于 lib/）
bash e2e/run.sh                                  # 真实 DSH + 本地 SSE 抓包 stub，三段场景
```

- `e2e/run.sh`：以 `--from-default-profile headless` 创建 scratch profile、安装本仓插件、把 `deepseek-hint` 路由指向本地 stub，驱动真实 headless 任务。
- `e2e/stub-server.mjs`：记录每个请求（headers + body），按会话（解码 hint header）脚本化响应；同时充当状态端点接收器。
- `e2e/capture-check.mjs`：委派轮 + 会话复用轮的逐字段断言。
- `e2e/compaction-check.mjs`：溢出压缩轮的逐字段断言。

### 7.2 场景

| 场景 | 驱动 | 关键目的 |
| --- | --- | --- |
| S1 委派轮 | 主会话 `e2e_probe` 工具往返 → 前台 `subagent` 委派（子会话再走一次工具往返）→ 主会话收尾 | 身份、血缘、running/resume、pause 事件、动态 priority、动态 cache |
| S2 会话复用轮 | `--session-id` 复用 S1 会话，在新进程开第二轮（单次请求收尾） | `call_index` 续接、第二轮开局 priority 3、重启后 cache 保守抑制 |
| S3 溢出压缩轮 | 独立 stub 与 profile 叠加；第一步大工具载荷，第二步返回 `CONTEXT_WINDOW_EXCEEDED` → harness 摘要压缩 → 同步重试 | `epoch` 递增、压缩当轮 cache 抑制、下一轮恢复 |

### 7.3 抓包断言矩阵（主阶段：S1 + S2）

| 会话 | call_index | `agent_status.state` | `priority` | `cache_control` |
| --- | --- | --- | --- | --- |
| 根 | 1 | `running` | `3 / user_waiting` | `ephemeral, ttl_s=600`（无 interval 样本） |
| 根 | 2 | `resume` | `1 / critical_path` | `ephemeral, ttl_s=60`（probe 间隔钳制） |
| 根 | 3 | `resume` | `1 / critical_path` | `ephemeral, ttl_s=60` |
| 根（S2） | 4 | `running` | `3 / user_waiting` | **省略**（新进程签名未知 + `call_index > 1`） |
| 子 | 1 | `running` | `3 / user_waiting` | `ephemeral, ttl_s=600` |
| 子 | 2 | `resume` | `1 / critical_path` | `ephemeral, ttl_s=60` |

逐请求同时断言：

- `session_id` 在同一会话内稳定，根跨两轮不变；`agent_type === "agent"`；`epoch === 0`。
- 子会话携带 `parent_session_id === 根 session_id`，`derivation === {relation:"spawn", join:"sync"}`；根会话无血缘字段；任何请求无 `fork_point`。
- header `agent_status` 恰好只有 `state` 与 `state_since_ms` 两个键；`state_since_ms` 为有限数。
- `priority` 与预期逐字相等；无 `strict_priority`。
- 有 cache 声明时：恰一条、`type==="ephemeral"`、`range.unit==="message"`、`range.end === body.messages.length`。
- 请求体无 `agent_hints`；`session_id === x-deepseek-harness-session-id`。
- 至少 1 个辅助请求（session-title）不带 hint。

### 7.4 抓包断言矩阵（S3 溢出压缩）

| 顺序 | call_index | `epoch` | `agent_status.state` | `priority` | `cache_control` |
| --- | --- | --- | --- | --- | --- |
| 1 | 1 | 0 | `running` | `3 / user_waiting` | `ephemeral, ttl_s=600` |
| 2 | 2 | 0 | `resume` | `1 / critical_path` | `ephemeral, ttl_s=60`（本次返回 400 溢出） |
| 3（重试） | 2 | **1** | `resume` | `1 / critical_path` | **省略**（压缩重写后当轮抑制） |
| 4 | 3 | **1** | `resume` | `1 / critical_path` | `ephemeral, ttl_s=60`（下一轮恢复） |

附加断言：至少 1 个无 hint 且带 `x-deepseek-harness-compact: 1` 的辅助压缩请求；`range.end === body.messages.length`；state 只含四值词表内的折叠值。

### 7.5 状态事件通道断言

| 检查项 | 断言 |
| --- | --- |
| 词表 | 所有事件 `state ∈ {running, pause, finalize}`（任何通道不出现 `tool` / `suspend`） |
| S1 根会话 | 以 probe 的 `pause` 开场；存在 `agent:subagent` 的委托 `pause`，`reason==="await_tool"`，`call_id` 非空，`child_session_id === 子 session_id`；两个 turn 各产生一次 `finalize` |
| S1 子会话 | 序列严格为 `["pause","running","finalize"]`，`pause` 的 `reason==="await_tool"` 且工具名为 `e2e_probe` |
| S3 | 2 次 probe `pause`、以 `finalize` 结束（共 5 个事件） |
| 跨通道一致性 | 每个 `resume` 请求的 `state_since_ms` 与该会话对应 `running` 事件的 `state_since_ms` 逐一相等 |
| sink 一致性 | JSONL 文件序列与 HTTP 端点收到的序列逐字相同（S1：10 事件 / 2 会话） |

### 7.6 当前验证结果

- `npm run typecheck && npm run build && npm test`：**68/68 通过**。
- `bash e2e/run.sh`：**PASS**（主阶段 6 个带 hint 主请求、2 会话、10 个状态事件；压缩阶段 `epoch 0→1`、压缩轮 cache 抑制后恢复、2 个辅助请求）。

## 8. 单测补充覆盖（e2e 不驱动的分支）

| 分支 | 覆盖位置 |
| --- | --- |
| 并行工具：最后结果才报 `running`、暂停段起点不漂移 | `test/status.test.mjs`、`test/hint.test.mjs` |
| `resume` 一次性、turn 边界关闭窗口、子代理委托 | `test/hint.test.mjs` |
| `turnOpening` 判定与无 turn 事件兜底 | `test/hint.test.mjs` |
| TTL 钳制（60 / 3600 / 300 回退）、128 token 门槛、签名敏感度 | `test/cache.test.mjs` |
| 步间压缩与步内溢出重试两种 `afterCompaction` 形态 | `test/hint.test.mjs` |
| 静态 priority 折叠、`omit`、cache ephemeral-only/ttl 必填/单条/单位校验 | `test/apply.test.mjs` |
| 错误码映射（含 context-window → `CONTEXT_WINDOW_EXCEEDED`）、`failure` 快照 | `test/adapter.test.mjs` |

## 9. 已知边界

- **工具等待统一报 `pause`**（本部署裁决）：四值契约“工具执行中也算 running”的字面在发送侧折叠；消费侧对每次等待工具都看到 `pause`。
- `resume` 一次性语义在 harness 重试时会重发（发送方无法感知 header 是否送达）。
- 人工审批的优先级加成未实现：工具门与人工门不可区分，`level: 3` 仅覆盖 turn 开局请求。
- `fork_point`、`handoff` 关系不发射；`strict_priority` 永不发送。
- `prediction` 族不进入本期业务逻辑（配置了三份来源时仍随 header 发射，行为不变）。
- e2e 未覆盖：静态配置的线上形态、`derivation.join: "async"`（异步委托）、跨会话 fork 的 cache 行为——由配置/单测覆盖。

## 10. 配置速查

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `agentType` | 非空字符串，默认 `agent` | `session.agent_type` |
| `priority` | `"dynamic"`（默认）/ `{level, reason}` / `null` | 动态二值、静态覆盖（折叠）/ 省略 |
| `cacheControl` | `"dynamic"`（默认）/ `[{type:"ephemeral", ttl_s, ...}]` / `null` | 动态单条、静态逐字覆盖 / 省略 |
| `statusSink` | 文件路径 | 本地 JSONL 事件 sink |
| `statusEndpoint` / `statusAuto` | URL / 布尔 | HTTP 状态端点（显式覆盖 / 由 `baseURL` 推导 `<origin>/agent-status`） |
| `subagentToolNames` | 字符串数组，默认 `["subagent"]` | 委托工具识别（`agent:<name>`、`join`、子会话绑定） |
| `models` | `{id, name, contextWindow, maxTokens}[]` | 供 `resolveModel` 与 compaction 决策；自有网关必须给真实限额 |
