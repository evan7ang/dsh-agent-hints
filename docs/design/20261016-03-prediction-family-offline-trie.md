# 设计：prediction 全族字段 —— 离线 trie 统计 + 静态回退（v0.3.0 规划）

> Status: v1 (2026-10-16)。需求：实现 Agent Hint 协议 §2.6 `prediction` 全族（当前为已声明边界，schema 有定义、构造器不填）。参照 dynamo/NAT 方案（`nat.profiler.prediction_trie`：离线建 trie → 运行时 lookup → 静态值兜底）。
> 决策记录（2026-10-16 与需求方确认）：**引擎形态 = 离线 trie（dynamo 同构）**；**冷启动 = 预测命中→预测值，未命中→静态默认值（始终发射）**；**next_action 键 = 工具序列 trie**（DSH 无 NAT 的 function_path 工作流结构）；**`expected_resume_s` 本期含（配置传值，触发源后续接入）**。
> 协议依据：《Agent Hint 字段&实现定义》§2.6（字段表）、§3（数据来源：埋点采集 → 按会话/agent_type/上下文聚合 → 均值/分位数/样本数内部保存 → 发射前按策略取单值）。前置设计：[docs/design.md](../design.md)（v1 协议形状）、[20261016-02](20261016-02-harness-owned-model-delegation.md)（v3 架构，本文与其正交——prediction 是 hint 计算层的增量，不依赖传输架构归属）。

## 1. 字段 → 数据源 → 统计口径对照

| 协议字段 | 数据源（会话持久日志 / 状态事件） | 分布 | 发射取值 |
| --- | --- | --- | --- |
| `latency_ms` | `step/start` → `step/end` 时间差（每次 LLM 调用窗口） | p90 | `p90` |
| `output_tokens` | 会话日志 usage 事件（completion tokens；实施期对 session-format 精确核对字段口径） | p90 | `p90` |
| `interval_ms` | 相邻 `step/start` 时间差（两次调用间隔） | mean | `mean` |
| `remaining_calls` | 会话总调用数 − 当前 call_index（跨同位会话聚合） | mean | `mean` |
| `remaining_time_ms` | 会话总时长 − 已进行时长；或 `remaining_calls × (latency+interval)` 推导 | mean | `mean` |
| `next_action.state` | `turn/end(completed)` 为 finalize 终态转移；工具调用为 tool 转移 | 转移概率 | `prob` 最高的转移 |
| `next_action.tools[].name` | `tool/call` 序列转移（序列 trie） | — | 同上 |
| `next_action.tools[].expected_duration_s` | `tool/call` → `tool/result` 时间差 | mean | `mean` |
| `next_action.prob` | 该转移的样本占比 | — | 转移概率 |
| `expected_resume_s` | 本期配置传值（pause/suspend 状态事件发射时携带）；真值待 pause 触发源落地 | — | 配置值 |

口径原则：**p90 用于"越大越该预留资源"的量（延迟/输出 token），mean 用于节奏量（间隔/剩余调用）**——与 NAT（`output_tokens.p90`、`remaining_calls.mean`、`interarrival_ms.mean`）一致。

## 2. Trie 形态（dynamo 同构 + 工具序列键）

```jsonc
// prediction-trie.json（自定义格式 v1，NAT prediction_trie 的同构异形）
{
  "version": 1,
  "built_at": "2026-10-16T00:00:00Z",
  "agent_type": "agent",                    // 一次构建对应一个 agent_type（v1 边界，见 §6）
  "root": {                                 // 节点 = 会话内"已调用的工具序列前缀"状态
    "stats": {                              // 到达此节点的样本（= 该前缀后的剩余轨迹统计）
      "remaining_calls":   { "mean": 2.4, "count": 120 },
      "output_tokens":     { "p90": 640,  "count": 118 },
      "interval_ms":       { "mean": 250, "count": 112 },
      "latency_ms":        { "p90": 8200, "count": 118 },
      "remaining_time_ms": { "mean": 42000, "count": 90 },
      "next": {                             // 转移分布：下一状态（含工具）
        "transitions": [
          { "state": "tool", "tools": [{ "name": "web_search", "expected_duration_s": 8.2 }], "prob": 0.8, "count": 96 },
          { "state": "finalize", "prob": 0.2, "count": 24 }
        ]
      }
    },
    "children": { "web_search": { "stats": { … }, "children": { … } } }
  }
}
```

- **运行时 lookup**：以会话已发生的工具名序列（从会话日志 `tool/call` 顺序提取）自根向下走，**最长前缀匹配**——与 NAT `(function_path, call_index)` 键同构的"序列即上下文"泛化，天然覆盖同一会话内不同深度。
- **样本门槛**：节点 `count` 低于配置下限（`predictionMinSamples`，默认 5）视为未收敛，逐字段回退静态值。
- **无 trie 或未命中**：逐字段回退 `predictionStatic` 配置值；`next_action` 无静态语义（无法猜工具），静态回退时整块省略——标量字段始终发射，`next_action` 见 trie 才发射。

## 3. 发射面（wire 不变）

- `prediction` 块仍走 `X-Agent-Hint` 头（v1 通道零改动），仅 `hint.ts` 构造器按 lookup 结果填充；body 零 hint 字段不变。
- 发射条件：`predictionTrie` 或 `predictionStatic` 至少一项配置——**未配置任何 prediction 来源的部署行为与 v0.2.1 完全一致**（块省略）， opting-in 才发射。
- `expected_resume_s` 走状态事件通道：`StatusObserver` 进入 `pause`/`suspend` 时在 `agent_status` 同事件的 `prediction.expected_resume_s` 携带配置值（字段定义 §4 示例行 ② 口径）；`pause`/`suspend` 触发源仍未落地前该路径不激活，仅配置面就绪。

## 4. 模块与工具

| 位置 | 职责 |
| --- | --- |
| `src/prediction.ts`（新） | trie 加载（JSON 校验/容错）、序列 lookup、静态回退合成、逐字段取值策略；`PredictionSource` 接口供 hint.ts 消费 |
| `src/hint.ts` | 构造器增量：`prediction` 块填充（接口不变，入参多一个可选 prediction） |
| `src/status.ts` | pause/suspend 事件携带 `expected_resume_s`（触发源未接入前不发射） |
| `src/config.ts` | 新增 `predictionTrie?: string`、`predictionStatic?: PredictionStatic`、`predictionMinSamples?: number`、`expectedResumeS?: number` |
| `scripts/build-prediction-trie.mjs`（新） | 离线构建器：输入 DSH 会话日志（JSONL 目录）→ 聚合 → 输出 trie JSON；样本不足字段置 count=0（发射端自动回退） |

构建器管线：会话日志文件 → 按 session 分组重放（提取 tool 序列、step 时窗、usage、turn/end）→ 前缀 trie 累积分布 → 节点聚合（mean/p90/count）→ 剪枝（count < 构建门槛的子树保留但 stats 置零）→ 写 JSON。

## 5. 验证方案

- **单测**：trie 加载容错（缺字段/坏 JSON → 静态回退）、序列 lookup（命中/部分前缀/未命中）、逐字段回退合成、样本门槛、构造器发射形状（对照字段定义 §4 示例值）、构建器（样例日志 → 期望 trie）。
- **e2e**：现有 stub + 配置 `predictionStatic` → 抓包断言主线请求 `prediction` 块存在且值正确、body 零泄漏；trie 路径用单测覆盖（e2e 不引入离线构建依赖）。
- **门禁**：`npm run typecheck && npm run build && npm test` + `bash e2e/run.sh`。

## 6. 边界与风险

| 项 | 说明 |
| --- | --- |
| `agent_type` 分区 | trie 文件单 `agent_type`；多类型部署构建多份、配置按类型选择——v1 不做类型内键（会话日志不含 agent_type，需上游补充才有真分区） |
| usage 字段口径 | 会话日志 usage 事件的精确字段（completion tokens 位置）实施期对 `session-format` 核对；缺失时 `output_tokens` 字段回退静态值 |
| trie 陈旧度 | v1 不做 TTL 强制；`built_at` 随文件记录，由部署侧决定重建节奏 |
| pause 触发源 | `expected_resume_s` 配置就绪但事件路径待 `pause`/`suspend` 触发源（协议既有边界，非本期新增缺口） |
| LangGraph 侧共用 | trie 构建器消费 DSH 会话日志；LangGraph 侧状态事件流回灌是其 roadmap 项，两侧共享的是"trie 格式 + 取值口径"约定，本期以本文档为契约输出 |
