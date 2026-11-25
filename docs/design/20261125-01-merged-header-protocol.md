# 设计：两仓合并与 X-Agent-Hint 协议归一化

> 状态：2026-11-25。本文记录 `dsh-agent-hints`（本仓）吸收 `dsh-agenthint` 能力、把 wire 协议归一化为四块 `X-Agent-Hint` header 的设计。
>
> 取代关系：本文取代 [design.md](../design.md) / [design.zh.md](../design.zh.md)（v1）的字段形状与发射规则、[20261104-01](20261104-01-simplified-scenario-fields.md) 的 `agent_status` 四值/`priority`/`cache_control.range` 口径、[20261105-01](20261105-01-field-reference-and-e2e.md) 中与 header 形状相关的取值说明、[20261107-01](20261107-01-session-scoped-finalize-and-cache-range-fill.md) 的 `finalize` 与 `range` 补全裁决。历史文档保留，不覆盖。

## 1. 目标与边界

### 目标

1. 两个插件仓合并：`dsh-agenthint` 的端点继承、生命周期控制面、Messages 传输、trace、Web 配置面板并入本仓；`dsh-agenthint` 仓本身不再改动。
2. 协议归一化：所有 hint（数据面与生命周期）统一走 `X-Agent-Hint` 请求头，编码为 UTF-8 JSON 的 base64url；请求体零 hint 字段。
3. 字段收敛为四块：`session` / `context_management` / `priority_control` / `cache_control`，`session.state` 为 6 值。
4. 本仓现有带外 `/agent-status` 事件通道下线，生命周期改由 manage 请求表达。

### 非目标

- 不修改 MindIE-Motor（消费端另行跟进）；本文只给出消费端契约。
- 不更新外部测试框架（`agent-hint-harness-testing` 的 DS-01~18 判据基于旧协议）。
- 不升级到 DSH 0.2.2-rc.5 或更高；基线为 0.2.2-rc.1。
- 不保留 `agent_status`、`agent_type`、`derivation`、`prediction`、`strict_priority`。

## 2. 决策记录

| 议题 | 结论 |
| --- | --- |
| `session.state` 语义 | 沿用 dsh-agenthint 的 KV 生命周期触发；追加 `append` 表示普通请求 |
| 动词载体 | pause/resume/stop/compact 走独立 manage 请求，hint 在 header；start/append 搭普通请求 |
| 带外通道 | 下线（`statusSink` / `statusEndpoint` / `statusAuto` 及四值事件） |
| edits 归属 | 插件显式下发：pause→offload、resume→prefetch、stop→evict、compact→evict |
| start/append 分界 | 每会话一次 `start`（全新、不带历史），其余 `append` |
| priority/cache 时机 | 每条普通请求（cache 带抑制条件）；manage 请求与辅助请求不带 |
| 范围外字段 | 全部移除，包括 prediction 相关代码与配置 |
| 依赖模式 | 整体改用官方包（peerDependencies，DSH 0.2.2-rc.1） |
| chat adapter | 以 dsh-agenthint 的 `ChatCompletionsAdapter` 为主体，吸收本仓的超窗识别与占位输出 |
| 验收 | 仓内验证（typecheck / build / test / e2e），真实浏览器验收待执行 |

## 3. Wire 契约

### 3.1 编码与通道

```text
AgentHint 对象 → UTF-8 JSON → base64url（无 padding）→ X-Agent-Hint 头值
```

- 只存在于请求头。体与标准 chat-completions / messages 请求逐字节一致。
- 辅助请求（任意非空 `purpose`）不带任何 hint。
- 生命周期动词使用独立 manage 请求：`POST <baseURL>/v1/chat/completions`，body 为 `{ model, messages: [], stream: false }`，同一请求头带 hint。

### 3.2 字段

```jsonc
// 普通请求
{
  "session": { "session_id": "s-1", "parent_session_id": "p-1", "call_index": 5, "epoch": 1, "state": "append" },
  "priority_control": { "priority": { "level": 1, "reason": "critical_path" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 300, "msg_offset": 12 }
}

// manage 请求
{
  "session": { "session_id": "s-1", "call_index": 5, "epoch": 1, "state": "pause" },
  "context_management": { "manage_request": true, "edits": [{ "type": "offload", "target": "session" }] }
}
```

- `session.state` ∈ `start | append | pause | resume | stop | compact`。
- `session.call_index`：会话内主线调用序号，从 1 起（`step/start` 计数，含本次）。
- `session.epoch`：上下文版本（`compaction/end` 计数）；`compact` 的 manage 请求携带 `epoch - 1`。
- `session.parent_session_id`：仅在会话 header 明确记录父 ID 且不是 subagent 创建者时携带。
- `priority_control.priority.level` ∈ {1,3}，`reason` 与 level 对应（`user_waiting` / `critical_path`）。
- `cache_control.type` 恒为 `ephemeral`；`ttl_s = clamp(round(上次间隔 × 2), 60, 3600)`；`msg_offset` = 本次请求 wire 消息条数（1-based）。
- `context_management.manage_request` 为 JSON 布尔值；`edits[].target` 只发 `session`。

### 3.3 发射规则

| 场景 | 发射 |
| --- | --- |
| 全新会话首条普通请求 | `session(state=start)` + `priority_control` + 满足条件的 `cache_control` |
| 其余普通请求 | `session(state=append)` + `priority_control` + 满足条件的 `cache_control` |
| 辅助请求 / 无 sessionId | 无 |
| pause / resume / stop / compact | `session(state=动词)` + `context_management` |
| 压缩改写当轮 / 模型或工具集签名变化当轮 / 前缀 < 128 token | 省略 `cache_control` |

## 4. 生命周期控制面

- 触发沿用 dsh-agenthint：`session/created`（seeded 判定）、`session/event`（`compaction/end`）、`session/disposed`、`agent/status`、公开 `workspaceRegistry.archiveSession` 包装（归档即 stop）、composing RPC（草稿非空即 resume）。
- 数据面 lease 覆盖整条流；变更操作等待在途流；新普通请求等待控制队列尾（默认 2s 屏障）。
- 控制结果 accepted / failed / unknown / cancelled；仅 resume 的明确瞬态拒绝重试；未知 mutation 隔离并阻塞同会话新请求（`ControlBarrierError`）。
- `start`/`append` 记账在端点 2xx 后提交（Chat 在 `request` 内，Messages 在 `prepareExtensions.accept`）。
- `stop` 在进程退出时可能与退出竞争，可能只完成派发。

## 5. 传输

- **Chat**：自实现适配器；header 直接写入；保留 dsh-agenthint 的流合同（终态前 block-end、工具身份先校验、严格 usage、idle watchdog、错误分类），并吸收本仓的空工具输出占位、上下文超窗识别，以及与官方一致的 `x-deepseek-harness-session-id` / `x-deepseek-harness-compact` 身份头（非 hint 字段）。
- **Messages**：扩展官方 `DeepSeekAdapter`；官方无 per-request header 钩子，使用 AsyncLocalStorage + `resolveAuth` 的 headers 展开注入。`prepareExtensions` 不贡献任何字段，只保留 accept 记账。该接缝依赖官方实现细节，升级宿主需复核。

## 6. 配置

采用 schemastery `Config`（Web 模型页可配置），新增：

- `agentHint.priority`: `'dynamic' | 'omit' | { level, reason }`，默认 `dynamic`。
- `agentHint.cacheControl`: `'dynamic' | 'omit' | { ttl_s, msg_offset? }`，默认 `dynamic`。
- 保留 `agentHint.{enabled, trace, sessionControl}`、`provider`、`transport`、`inheritCredentials` 与协议字段。

已删除的键（`statusSink`、`statusEndpoint`、`statusAuto`、`agentType`、`prediction*`、`subagentToolNames`）不做专门检测；未定义键按 schemastery 默认行为忽略。

## 7. 消费端契约（后续 Motor 改动）

1. 入口校验前解码 `X-Agent-Hint`；`context_management.manage_request=true` 的请求允许空 `messages`。
2. `session.state` → 现有 `session_control.type`；白名单补 `append`（与 `start` 一样不触发动作）。
3. `context_management` → 引擎可见的 body `agent_hint.context_management`。
4. `priority_control.priority.{level,reason}` → 现有 `priority_control`；限流中间件改读这里。
5. `cache_control.{ttl_s,msg_offset}` 现有解析已支持。
6. 本插件不再向 `/agent-status` 上报；消费端该通道的 KVC 编排输入消失。

在 Motor 跟进前：普通请求的会话身份与缓存声明仍可被现有解析读取；manage 请求被现有入口以 400 拒绝（插件记为 failed 并告警）；优先级准入不生效。

## 8. 验证

- `npm run check`：`tsc -b --force`、`tsc -b` + client bundle、vitest（含 stock Loader / AgentLoop / Tools / BasicCompaction 集成）、`node --test tests/trace.test.mjs`、包内容与锁一致性。
- `bash e2e/run.sh`：DSH 0.2.2-rc.1 + 本地捕获 stub；断言四块形状、6 值 state、`start`/`append`、`resume` manage 请求、`stop` 派发、占位 body、body 零 hint、标题请求无 hint、`msg_offset` = wire 条数。
- 待验收：真实浏览器打字触发（组件测试覆盖逻辑，DOM 契约未在真机验证）；真实引擎 KV 动作与性能；Motor 消费端跟进后的端到端。

## 9. 风险

1. Motor 未跟进时生命周期与优先级静默失效（有 WARN，不报错）。
2. Messages header 接缝依赖官方 adapter 的 `resolveAuth` 行为。
3. 进程退出时的 `stop` 可能丢失。
4. 浏览器 DOM 标记随 DSH 版本变化。
5. 外部测试框架与其余 harness 插件仍按旧协议，需另行更新。
