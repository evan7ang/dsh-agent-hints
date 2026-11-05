# 任务：简化场景三类字段实现与验证

> 关联设计：[20261104-01-simplified-scenario-fields](../design/20261104-01-simplified-scenario-fields.md)。规范依据为 `docs/handoffs/` 三份文档，冲突处以其为准。

## 目标

按设计文档在 DSH 插件中实现 `priority`（二值动态）、`agent_status`（四值折叠）、`cache_control`（动态单条 ephemeral）三类字段的取值与发送逻辑；`prediction` 族不动。

## 实现路径

1. `src/hint.ts`：`agent_status.state` 收窄四值；`HintRequestFacts`/`HintOptions` 重构（priority/cacheControl 移入 per-request facts）；`deriveServingFacts` 扩展为单次日志扫描，输出 `state/stateSinceMs/turnOpening/intervalMs/afterCompaction`。
2. `src/cache.ts`（新增）：前缀 token 估算、TTL 推导与钳制、单条 ephemeral 组装，纯函数。
3. `src/status.ts`：事件词表折叠（`tool`→`pause`），移除 `emitPause`/`expectedResumeS`，任何 `turn/end` 清未决。
4. `src/config.ts`：`priority`/`cacheControl` 三态语义（动态 / 静态 / 省略），静态 priority 折叠进 `{1,3}`，cache 静态收紧 ephemeral-only + ttl 必填，移除 `expectedResumeS` 与两个 DEFAULT 常量。
5. `src/index.ts` + `src/adapter.ts`：`priorityOf(facts)` 接线；`stream()` 先序列化再建 hint，计算 cache 并维护进程内模型/工具签名；修正过时注释。
6. 测试与 e2e 同步更新；README ×2、版本号与构建产物。

## 验收标准

- `npm run typecheck && npm run build && npm test` 全绿。
- `bash e2e/run.sh` 通过，抓包断言：请求 1 `running`/`3,user_waiting`/`ttl_s=600`；请求 2 `resume`/`1,critical_path`/`ttl_s=60`；两请求 `range.end === body.messages.length`；sink 序列 `pause → running → finalize`；无 `tool`/`suspend` 字面；`strict_priority` 不出现；body 零 hint；`prediction` 块与现状一致。
- 单测覆盖：pause 并行等待、resume 一次性、turn 边界、子代理委托 pause、turnOpening、TTL 钳制与三项抑制、priority 折叠、配置组合期报错。

## 进展与结果

- 2026-11-04：设计与任务建档；开始实施。
- 2026-11-04：实施完成。新增 `src/cache.ts`（token 估算 / TTL 钳制 / 单条 ephemeral / 前缀签名）；`src/hint.ts` 四值状态类型与扩展派生（callId 配对、pause 段起点、resume 一次性、turnOpening、intervalMs、afterCompaction）；`src/status.ts` 词表折叠为 `pause|running|finalize`、移除 `emitPause`、任何 `turn/end` 清未决；`src/config.ts` 三态 priority/cacheControl、静态 priority 折叠、pin 报错、移除 `expectedResumeS`；`src/index.ts` 接线 `priorityOf`；`src/adapter.ts` 先序列化后建 hint、动态 cache 与签名抑制、版本串 0.3.0。
- 验证结果：
  - `npm run typecheck && npm run build && npm test`：66/66 通过（新增 `test/cache.test.mjs`，hint/apply/status/adapter 断言同步更新）。
  - `bash e2e/run.sh`：PASS。抓包断言：主请求 1 `running` / `{3,user_waiting}` / `ttl_s=600`；主请求 2 `resume` / `{1,critical_path}` / `ttl_s=60`；两请求 `range.end === body.messages.length`；状态 sink `pause → running → finalize`（`await_tool` + `tools[].call_id`）；`resume.state_since_ms` 与 sink running 事件一致；prediction 静态块原样保留。
- 实施中发现并修正：pause 段起点在并行调用部分结算后应保持首调用时刻（原按当前未决集取 min 会漂移）；`afterCompaction` 需限定在上一与当前 `step/start` 之间（原来会误判当前请求之后的压缩）。
- 2026-11-04：完整字段级 e2e 补齐（真实 DSH 驱动 + 抓包断言，见设计 §5.1）：
  - 委派轮（主会话工具往返 + 前台 `subagent` 子会话）验证 session 身份/血缘/call_index/epoch、running/resume、priority 3→1、动态 cache 与 pause/child 绑定；
  - `--session-id` 复用会话的第二轮验证 call_index 续接、开局 priority 3、重启后 cache 抑制；
  - 溢出压缩轮验证 `epoch` 0→1、压缩当轮 cache 抑制（含步内重试）与下一轮恢复。
  - 过程中发现并修复两处适配器保真缺陷：`AdapterError` 缺 own `failure` 快照导致错误码被归一化为 `UNKNOWN`；缺 `imageRequestPricing()` 导致 token meter 抛错、自动压缩静默失效。另将 context-window 措辞映射为 `CONTEXT_WINDOW_EXCEEDED`。
  - 最终验证：`npm run typecheck && npm run build && npm test` 68/68；`bash e2e/run.sh` 全 PASS（主断言 6 主请求/2 会话/10 状态事件，压缩断言 epoch 0→1 + cache 抑制/恢复）。
- 待验收：无（单测与三段 e2e 均已执行）。
