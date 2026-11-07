# 设计：会话级 finalize、静态 cacheControl 的 range 补全与 harness 0.2.2 消息词表适配

> 状态：2026-11-07。外部测试框架（agent-hint-harness-testing，DSH 子集 18 用例 PASS 16 / FAIL 2）报告两条失败：
> DS-06（事件通道 `finalize` 每个 completed turn 发一次）与 DS-12（静态 `cacheControl` 覆盖条目缺 `range`）。
> 本文记录两条修复的语义裁决，以及验证过程中发现的 harness 0.2.2 消息词表漂移适配。
>
> 取代关系：本文取代 [design.md](../design.md) / [design.zh.md](../design.zh.md) §4 中 `turn/end(completed) → finalize` 的触发源描述、
> 以及 [20261104-01](20261104-01-simplified-scenario-fields.md) §3.2 的 `finalize` 承载映射与「静态数组为逐字覆盖」表述；其余内容不变。

## 1. finalize 改为会话级（DS-06）

### 语义裁决

`finalize` 的协议语义是**会话级**：「这个会话结束了，会话级资源可以释放」（RFC §3.3；消费方据此解会话亲和 pin）。
插件此前把每个 `turn/end` 且 `reason.kind === 'completed'` 都当作完成判据发一条 `finalize`——这是**轮次级**语义。
单进程多轮会话（当前 DSH headless 的 background delegation 流程一根会话两个 completed turn）下，消费方会在第一轮结束时就解 pin，
而该会话后续请求仍在发 hint，等于"会话中途被宣告结束"，亲和与缓存复用语义都被破坏。

裁决：`finalize` 的唯一触发源是 DSH 的会话终结事件 `session/disposed`（`@deepseek-ai/dsh-session`：会话离开 store 时恰好发一次）。
`turn/end` 只负责清理观察器的 pending / pauseSince 状态，不再发任何事件。

### 性质

- **恰好一次、且是最后一条**：`session/disposed` 每个会话生命周期发一次；处置之后不会再有该会话的任何事件，因此 `finalize` 恒为子流最后一条事件。
- **多轮会话只发一次**：一根会话 N 个 completed turn 只在终结时发一条 `finalize`。
- **从不关闭的会话不发**：合法（判据明确豁免）。
- **无工具等待的会话也要发**：只发请求（header）的会话同样会被消费方 pin，处置时无条件发 `finalize` 作为释放信号；`state_since_ms` 取处置时刻（`Date.now()`）。
- **跨进程收养的会话**：每个进程生命周期各发一条（每个进程里的调度视图各自 pin/释放）。测试框架的场景是单进程会话，不受此影响。
- **落盘时序**：`session/disposed` 同步派发，JSONL 文件 sink（`appendFileSync`）在处置返回前落盘；HTTP sink 异步队列在正常退出路径
  （`shutdown()` → fiber dispose → `process.exitCode` 自然退出）下由在途 fetch 持有事件循环，投递完成后进程才退出，finalize 不会丢。

### 不做

- 不新增"每轮结束"事件类型：当前无消费方需求；若后续需要，新增独立事件，不复用 `finalize`。
- `agent/status` 的 `idle` 仍不映射为 `finalize`（维持既有裁决）。

## 2. 静态 cacheControl 条目的 range 补全（DS-12）

### 语义裁决

静态 `cacheControl` 数组覆盖的是**策略**（`type` / `ttl_s`），不是**范围**。判据 `rfc.cache_range` 要求每条 `cache_control` 声明都带
`range.end`（≥1 整数）且 `range.unit === "message"`——只给 `ttl_s` 不给 `range`，消费方不知道保哪一段，等价于没有声明。

裁决：静态条目**未显式给 `range` 时**，发送时按本次请求的 wire 消息条数补 `range: { end: body.messages.length, unit: "message" }`
（与动态路径同一口径）；**显式给了 `range` 则逐字尊重配置**（含部分字段与 `end: null`，属于用户的显式选择）。
配置校验不变（`range` 仍为可选），不新增配置期报错。

### 性质

- 与动态路径一致：`range.end` 随每次请求的输入条数，同 (session, epoch) 内单调不减（满足 `rfc.cache_end_monotonic`）。
- 抑制规则不变：签名变化 / 压缩当轮的抑制先于静态分支生效；静态条目不参与最小前缀 token 检查（显式覆盖维持原语义）。

## 3. harness 0.2.2 消息词表适配（验证中发现，先行修复）

验证中发现本机 dsh 已于 2026-11-06 升级到 0.2.2-alpha.2，消息词表发生两处演进，插件三处读取失效（外部框架同版本采集中同样存在，
但其判据未覆盖，未报红）：

| 演进 | 影响 | 适配 |
| --- | --- | --- |
| 工具结果从「user 消息内嵌 `tool-result` 内容块」改为「独立的 `role: 'tool'` 消息、顶层 `toolCallId`」 | `deriveServingFacts` / `StatusObserver` 配对失效（pause 卡死、缺 `running`）；`serializeMessages` 把 tool 消息降级为 user 消息、丢失 `tool_call_id` | `hint.ts` 导出 `toolResultCallId()` 双形态提取（顶层 `toolCallId` 优先，回退 `tool-result` 块），两处配对共用；`serializeMessages` 增加 `role: 'tool'` 分支输出 wire `{role:'tool', tool_call_id, content}`。两种词表都兼容（harness 源码 checkout 仍是旧形态） |
| `subagent` 工具取消前景等待（每次调用立即返回 `started subagent <id>` ack，完成通知经 inbox 开启新一轮） | e2e 流程变化：根会话多一条 ack 后的 resume 请求与一个通知轮次；`run_in_background` 参数已从工具中移除 | e2e 断言按新流程重写（根 5 请求：probe → spawn-ack resume → 终答 → 通知轮 → 收养轮）；stub 剧本参数改 `run_in_background: true`，`derivation.join` 断言跟随声明值为 `async`。join 跟踪机制（读调用参数）本身不变 |
| `settings.yaml` 改为 profile 创建时一次性导入 | e2e 写 `settings.yaml` 切模型路由静默失效（run 1 打到官方路由报 MISSING_CREDENTIAL） | 模型绑定改走 patch overlay（`- id: agent-default-model` 行），与外部框架 `dsh_run.sh` 同一做法 |

### 遗留问题（不在本期）

- `derivation.join` 读的是调用参数的声明值；当前 harness 的 `subagent` 恒为 background 语义，声明 `sync` 时字段与实际等待模式可能不一致。
  是否改为按运行时行为推导需要协议层裁决，另行处理。
- inbox 通知触发的轮次开局按二值规则报 `3/user_waiting`（非真实用户介入）；是否区分通知轮开局需要协议层裁决，另行处理。

## 4. 验证设计

- **单测**（`node --test`，对 lib/ 产物）：completed turn 不发 `finalize`、disposal 发且为最后一条、无工具等待会话 disposal 也发；
  双形态 `tool/result` 配对（hint 派生与 status 观察各一条）；`role: 'tool'` 消息序列化；静态 `cacheControl` 无 `range` 按请求条数补全、
  显式 `range` 逐字尊重、`null` 省略；状态通道激活时才注册 `session/disposed` 监听。
- **e2e**（`bash e2e/run.sh`）：真实 DSH 0.2.2-alpha.2 跑 delegation + 收养 + 压缩三场景；断言根会话 5 条主请求的状态/优先级/cache 逐字段、
  状态事件流每会话至多一条 `finalize` 且为最后一条、文件 sink 与 HTTP sink 序列一致。
- **外部框架复跑**：DS-06 / DS-12 判据语义核对（每 `(session_id, source)` 子流至多一条 `finalize`；每条 cache 声明带 `range.end` + `unit=message`）。
