# 设计：简化场景三类字段的 DSH 实现（priority / agent_status / cache_control）

> 状态：2026-11-04。本文记录 `priority`、`agent_status`、`cache_control` 三类字段在 DSH 侧的取值与发送设计。规范依据为 `docs/handoffs/` 下的三份文档（下称“handoffs”），与 `agent-hint/Agent Hint字段&实现定义.md`（下称“字段定义文档”）冲突处一律以 handoffs 为准。`prediction` 族字段不在本期范围，现有发射机制保持不变。
>
> 本文补充并取代 [design.zh.md](../design.zh.md)（v1）中 `agent_status` 五值、`priority` 静态配置、`cache_control` pin 默认值的描述。

## 1. 目标与边界

- **目标**：让 DSH 插件的三类字段符合 handoffs 定义的语义与线缆约束，且取值全部从会话持久日志派生（重启安全）。
- **明确不做**：
  - `prediction` 族（含 `expected_resume_s`）：不进入本期业务逻辑；现有 `predictionFacts`/trie/static 机制原样保留。`expectedResumeS` 配置属于该族且从未激活，随死代码移除。
  - `strict_priority`：协议规定由可信控制面注入，插件永不发送（维持）。
  - `fork_point`/`handoff`：维持既有声明不做。
  - 辅助请求（compaction / session-title）仍不带任何 hint。

## 2. 冲突裁决记录

| 冲突 | 裁决 |
| --- | --- |
| `agent_status.state` 词表 | 四值 `running \| pause \| resume \| finalize`。`tool`、`suspend` 在任何通道的出口折叠，消费方只会看到四值（`AGENT_STATUS_STATE_DESIGN.md` §2.3）。字段定义文档 §2.2 的五值定义作废。 |
| `cache_control.type` | `pin` 退役，仅 `ephemeral`；`ttl_s` 必填且显式才生效；数组只放一条（`CACHE_CONTROL_IMPLEMENTATION_GUIDE.md` §2.1/§3）。字段定义文档 §2.5 的 `pin\|ephemeral` 双值与全量示例（pin+ephemeral 两条）作废。 |
| `priority.level` 域 | 二值 `{1, 3}`，出口折叠：`{1,3}` 原样、`{2,4}` 就近（2→1、4→3）、越界按准入线（≥3→3，否则→1）（`Agent-Hint-priority二值化-实施与验证总结-20261022.md` §1/§5）。字段定义文档 §2.3 的无约束整数作废。 |
| cache 指南 §6.4/§7.3 的 `agent_status` 映射（“执行工具时 tool”） | 被四值契约推翻：工具等待按本设计的 `pause` 发射，任何通道不出现 `tool` 字面。 |
| `range.end` 计数约定 | 1-based 含端点 = 前缀消息条数。对 `start=0` 的前缀声明与既有半开解释数值等价，无迁移风险。 |

字段定义文档位于 `agent-hint/`（需求侧输入材料，未入库），不修改；取代关系以本文为准。

## 3. DSH 映射

### 3.1 `agent_status`

请求头每次主请求携带 `state` + `state_since_ms`（仅这两个键，排障字段走事件通道）。

| 状态 | 判定（会话日志派生） | `state_since_ms` |
| --- | --- | --- |
| `pause` | 存在未配对的 `tool/call`（按 `callId` 与 `tool/result` 的 `toolCallId` 配对） | 最早未决 call 时刻（本次 pause 段进入时刻） |
| `resume` | 最近一次“未决清空”（或 turn 边界，取较晚者）之后的 `step/start` 恰为当前 in-flight 请求 | 放行时刻（清空未决集的那次 `tool/result`） |
| `running` | 其余（默认；`resume` 只报一条，第二个请求起回 `running`） | `max(最近 turn/start, 最近放行)`，均无则请求时刻 |

- **触发语义（按需求方裁决）**：任何工具调用都视为 agent 在“等人/等外部结果”，进入 `pause`；工具结果返回即放行。这与四值契约 §2.2“工具执行中也算 running”的字面不同，是本部署的明确选择；好处是词表严格四值，且 `pause + reason/tools` 比 `running + tools` 语义更自然。消费侧（Motor）会把工具等待按 `pause` 处理。
- **header 不携带 `finalize`**：DSH 跑完一轮后没有“收尾请求”，且契约 §4.4 规定下一轮首请求必须回到 `running`，物理上没有合规承载点。`finalize` 由 `turn/end(completed)` 的带外状态事件承载。
- **一次性语义与重试**：`resume` 在首次构造时消费；harness 重试会重发同一 hint。发送方无法感知 header 是否送达，属已知边界。
- **事件通道折叠**（`src/status.ts`）：
  - `tool/call` → `{state: "pause", reason: "await_tool", tools: [全部未决]}`（并行时每次重报全量；子代理委托仍用 `agent:<tool>` 并在子会话首现时补 `child_session_id`）；
  - 未决清空 → `{state: "running", state_since_ms: 放行时刻}`；
  - `turn/end(completed)` → `finalize`；任何 `turn/end` 清空未决集。
  - 事件词表收敛为 `running | pause | finalize`（`resume` 是请求域概念，放行以 `running` + 新 `state_since_ms` 表达）。

### 3.2 `priority`

| 请求 | `level` | `reason` |
| --- | --- | --- |
| turn 开局请求（最近 `turn/start` 后的首个 `step/start`；日志无 `turn/start` 时退化为 `call_index === 1`） | 3 | `user_waiting` |
| 其余一切（自驱续接、工具放行后的 `resume` 请求、压缩后续接） | 1 | `critical_path` |

- 未配置 = 动态二值（新默认）；显式配置 = 静态覆盖（组合期折叠进 `{1,3}`）；`null` = 省略整个字段。
- 工具放行后的 `resume` 不提升 `priority`：工具完成是机器事件，不是用户介入。人工审批门与工具门在本设计下不可区分，审批恢复加成无法实现（已知边界）。
- 压缩维护天然为 1：compaction 是辅助请求本就不带 hint，其后的主请求是续接。

### 3.3 `cache_control`

- 每次主请求至多一条 `{type: "ephemeral", ttl_s, range: {end, unit: "message"}}`。
- `range.end` = 本次实际发出的 wire 消息条数（含 system、含 tool-result 展开后），由适配器序列化结果精确得出。
- `ttl_s = clamp(round(gap × 2), 60, 3600)`，`gap` 取最近一次请求间隔（当前 `step/start` − 上一 `step/end`），无样本回退 300 秒。指南的“下一工具预计耗时”信号依赖 `prediction.next_action`，本期不启用。
- **抑制**：
  - 前缀估算 < 128 token（CJK 感知启发式）不发；
  - 压缩后当轮不发（`compaction/end` 位于上一 `step/start` 与当前之间）；
  - 模型或工具集变化当轮不发（进程内签名比对；`call_index > 1` 且签名未知（进程重启后）保守跳过）。
- 跨会话 fork 不抑制：新会话的输入即真实前缀，声明合法。
- 静态配置收紧为 `ephemeral`-only、`ttl_s` 必填；`pin` 在组合期报错。

## 4. 取值来源与重启安全

全部信号来自 `Session.ownEvents()` 的持久日志：`turn/start`、`step/start`、`step/end`、`tool/call`、`tool/result`、`compaction/end`、`turn/end`。恢复会话重放日志，因此 `pause`/`resume`/`turnOpening`/`intervalMs`/`afterCompaction` 均随日志续接。唯一进程内状态是 cache 的模型/工具签名与基础设施缺失时的 call_index 兜底。

## 5. 验证设计

- 单测：状态机（pause 并行、resume 一次性、turn 边界关闭窗口、子代理委托）、动态 `priority`、TTL 钳制与三项抑制、token 估算、静态折叠与配置报错。
- e2e（`e2e/run.sh`，免 key 抓包）：主请求 1 = `running` + `{3,user_waiting}` + `ttl_s=600`；主请求 2 = `resume` + `{1,critical_path}` + `ttl_s=60`；两请求 `range.end === body.messages.length`；状态 sink 序列 `pause → running → finalize`（pause 带 `await_tool` 与 `tools[].call_id`）；`state_since_ms` 跨通道一致。

### 5.1 完整字段级 e2e（2026-11-04 补）

`e2e/run.sh` 用真实 DSH 驱动三段场景，抓包逐字段断言：

1. **委派轮**：主会话普通工具往返 → 前台 `subagent` 委派（子会话再走一次工具往返）→ 主会话收尾。验证 `session_id`/`agent_type`/`call_index`/`epoch=0`、`parent_session_id` + `derivation {relation:"spawn", join:"sync"}`、`fork_point` 不出现、`running`/`resume` 一次性、`pause` 事件（`agent:subagent` + `child_session_id` FIFO 绑定）、动态 `priority` 3→1、动态 cache（`ttl_s` 600→60 + `range.end === body.messages.length`）。
2. **会话复用轮**：`--session-id` 复用同一会话开第二轮（新进程）。验证 `call_index` 续接、第二轮开局 `running` + `priority 3`，以及重启后签名未知的保守 cache 抑制。
3. **压缩轮**：`HINT_E2E_OVERFLOW` 场景下 provider 返回 `CONTEXT_WINDOW_EXCEEDED`，harness 走溢出恢复 → 摘要辅助请求（无 hint、带 `x-deepseek-harness-compact`）→ `epoch` 0→1 → 同一步重试。验证压缩当轮 cache 抑制（含步内溢出重试），下一轮恢复声明。

### 5.2 适配器保真修复（e2e 驱动发现）

压缩链路的端到端验证暴露了两处结构化适配器缺陷，已修复：

- `AdapterError` 必须携带 own `failure` 快照（`{message, code, status?}`）。harness 对跨包适配器错误按 `failure` 归一化；缺失时所有错误码退化为 `UNKNOWN`，重试层无法按码路由。
- 适配器必须实现 `imageRequestPricing()`（返回 `undefined`）。`tokenMeter.measure()` 无条件调用它；缺失会让测量抛错，进而使自动压缩（压力/溢出）静默失效。
- `httpErrorCode` 增加 context-window 措辞识别 → `CONTEXT_WINDOW_EXCEEDED`，与官方适配器对齐，打通溢出恢复路径。
