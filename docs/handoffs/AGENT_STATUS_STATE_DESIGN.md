# `agent_status.state` 设计说明（供 Dify / DSH 等 Harness 适配）

| 项 | 值 |
|---|---|
| 版本 | 1.0（2026-11-03） |
| 适用范围 | AgentHint 协议里的 `agent_status` 块 |
| 参考实现 | Pi（`pi-agenthint`）、Hermes（`hermes-agent-hint`） |
| 基线来源 | DSH 已发布实现 `evan7ang/dsh-agent-hints` 的 `src/hint.ts` / `src/status.ts`，本版在其基础上做了一处收敛（见 §2.2） |

---

## 1. 这个字段解决什么问题

一次模型请求里，引擎（或调度层）想知道的不只是"这条请求有多长"，还有**"这个 agent 现在处在什么处境"**。

三种处境会影响调度决策：

- **有人卡住了**（在等审批、等人回话）——这条请求后续会很敏感，值得优先保障
- **人刚放行**（审批刚通过）——接下来是一段连续工作，值钱的是"别把它刚恢复的上下文丢掉"
- **这次跑完了**——没有后续了，别再为它预留任何东西

`agent_status.state` 就是把这三件事（外加"正常干活"这个默认态）压缩成一个字段，随每次请求下发。

它**不描述**"agent 内部在干什么"——是在读文件、在跑测试、在写代码。这些细节既不跨框架统一，也不影响调度决策。

---

## 2. 契约

### 2.1 字段形状

```jsonc
{
  "session": { "session_id": "...", "call_index": 3, "epoch": 0 },
  "agent_status": {
    "state": "running",        // 四值之一，见 §2.2
    "state_since_ms": 1793594053264   // 进入该状态的 Unix 毫秒时间戳
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `state` | 是 | 四个枚举值之一 |
| `state_since_ms` | 强烈建议 | 进入当前状态的时刻（不是请求发出的时刻）。消费方用它判断"卡了多久" |

**只有这两个字段。** `reason`、`tools` 等细节**不属于**这个块（见 §6）。

### 2.2 四个状态

```ts
type AgentState = 'running' | 'pause' | 'resume' | 'finalize'
```

| 值 | 含义（一句话） | 典型触发 |
|---|---|---|
| `running` | agent 在正常工作 | 默认态；工具执行中也算 running |
| `pause` | 有人卡住了，agent 在等人 | 审批弹窗、澄清提问、人工确认 |
| `resume` | 刚刚被放行 | 审批/提问被回答后的**第一条**请求 |
| `finalize` | 这次任务结束了 | 会话收尾、run 完成后的**第一条**请求 |

### 2.3 与 DSH 原协议的差异

DSH 已发布的枚举是五个：

```ts
' running | tool | pause | suspend | finalize '
```

本版做了两处收敛：

| DSH 原值 | 本版处理 | 原因 |
|---|---|---|
| `tool` | **折叠为 `running`** | "在跑工具"对调度没有意义——agent 仍在工作，和 `running` 无法区分 |
| `suspend` | **折叠为 `pause`** | "等待超过阈值"和"有人卡住了"在消费侧是同一件事，只是等得更久 |
| — | **新增 `resume`** | 人放行是一条真实发生、且调度需要知道的边：它标记"接下来是连续工作" |

折叠是**发送方的责任**：harness 在出口把内部状态映射成这四个值，消费方只会看到四个值。

---

## 3. 内部状态 → 线缆值 的映射

每个 harness 内部都有更细的状态机，出口按下表折叠：

| 内部状态（各家叫法不同） | 线缆值 |
|---|---|
| idle / ready / thinking / generating | `running` |
| tool / tool_call / executing_tool | `running` |
| waiting_approval / awaiting_human / blocked | `pause` |
| suspended / timed_out / checkpoint | `pause` |
| just_resumed / approval_granted | `resume` |
| done / completed / ended | `finalize` |

映射原则只有一条：**"消费方能据此做的决策"必须相同，否则不能合并。**

- `tool` 和 `running` 合并，因为两者消费方都无所事事
- `suspend` 和 `pause` 合并，因为两者都意味着"有人在等，但可能等很久"
- `resume` 不能合并进 `running`，因为它携带一个时间点：从这一刻起上下文值得保留

---

## 4. 时序规则

### 4.1 `running` 是默认态

一条普通请求就发 `running`，不需要任何事件驱动。

### 4.2 `pause` 进入即生效，持续到被放行

```
审批弹窗出现 → 之后每条请求都是 pause（如果这期间还发请求的话）
```

`pause` 可以持续多轮：agent 在等，期间若有心跳请求，仍报 `pause`。

### 4.3 `resume` 只描述一条请求

```
第 N 条请求：state = pause
（人点了同意）
第 N+1 条请求：state = resume        ← 只这一条
第 N+2 条请求：state = running
```

**为什么只报一条**：`resume` 的含义是"刚刚发生了放行这个事件"，事件只发生一次。报了两次，消费方会以为又被放行了一次。

### 4.4 `finalize` 同样只描述一条请求

```
最后一条正常请求：state = running
（会话结束）
收尾请求：state = finalize            ← 只这一条
（若之后还有新请求）
下一条请求：state = running            ← 新一轮开始
```

### 4.5 `state_since_ms` 记的是"进入时刻"

不是请求时刻，也不是响应时刻。

```
pause 在 10:00:00 开始 → 10:05:00 的请求里 state_since_ms = 10:00:00
```

消费方用它算：`现在 - state_since_ms = 已经卡了多久`。

---

## 5. 消费方（调度 / 引擎）应如何使用

| 看到 | 可以做的 | 不该做的 |
|---|---|---|
| `running` | 正常排队 | 不要据此推断"agent 在干什么" |
| `pause` | 提高优先级；按 `state_since_ms` 计算已等待时长 | 不要假设它一定会恢复 |
| `resume` | 优先保障这段上下文；可标记"接下来是连续工作" | 不要缓存"resume 会持续"——它只有一条 |
| `finalize` | 释放为该会话预留的资源 | 不要假设会话永久结束（用户可能再开一轮） |
| 字段缺失 | 按 `running` 处理 | 不要报错或拒绝请求 |

**必须遵守三条**：

1. **缺失即默认**：`agent_status` 整块可能不存在（老版 harness），消费方按 `running` 处理
2. **未知值不拒绝**：未来可能加入第五个值，消费方应忽略未知值而不是丢弃整个请求
3. **不要当强信号**：这个字段是 advisory，不能被用作鉴权或计费依据

---

## 6. 与 out-of-band status event 的关系

同一份 `agent_status` 形状还会以**独立事件**的形式，从另一条通道发出（JSONL / HTTP sink），用于可观测性。

两者的区别：

| | 请求 header 里的 `agent_status` | 独立状态事件 |
|---|---|---|
| 用途 | 让引擎做调度决策 | 让观测系统重建轨迹 |
| 内容 | 只有 `state` + `state_since_ms` | 可以带 `reason`、`tools[]`、`child_session_id` 等 |
| 频率 | 每次请求一条 | 每次状态变化一条 |
| 丢失后果 | 少一次提示 | 轨迹缺一段 |

**设计原则**：header 只带"消费方要用的"，事件带"人要看的"。所以排障字段（`reason`、`tools`）只出现在事件里，不占 header 预算。

> 若某个 harness 没有独立事件通道，把 `reason`/`tools` 丢掉即可——它们对调度没有作用。

---

## 7. 新 Harness 接入清单

按顺序做，每步都能独立验证：

| # | 步骤 | 验收 |
|---|---|---|
| 1 | 定义内部状态 → 四值的映射表（照 §3） | 表格能覆盖所有内部状态，无遗漏 |
| 2 | 在**每条**请求出口写 `agent_status` | 抓一条请求，能解出 `state` 与 `state_since_ms` |
| 3 | 实现 `pause` 的进入/退出 | 触发一次人工审批，前后两条请求分别看到 `pause`、`resume` |
| 4 | 实现 `resume` 的一次性 | 审批后第三条请求必须是 `running` |
| 5 | 实现 `finalize` 的一次性 | 会话结束后第一条请求是 `finalize`，第二条回到 `running` |
| 6 | 校验枚举 | 任何情况下发出的 state ∈ 四值 |

---

## 8. 测试要求

最低要覆盖这 8 条：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 普通请求 | `state = running` |
| 2 | 工具执行中的请求 | `state = running`（不是 `tool`） |
| 3 | 审批弹窗后的请求 | `state = pause` |
| 4 | 审批通过后的第一条 | `state = resume` |
| 5 | 审批通过后的第二条 | `state = running` |
| 6 | 会话结束后的第一条 | `state = finalize` |
| 7 | 会话结束后的第二条 | `state = running` |
| 8 | 任一条请求 | `agent_status` 只有 `state` 与 `state_since_ms` 两个键 |

第 8 条容易被忽略，但它是"不让排障字段回流进 header"的守门测试。

---

## 9. 常见错误

| 错误 | 后果 | 正确做法 |
|---|---|---|
| 工具执行时报 `tool` | 消费方不认识 → 视为未知值 | 折叠成 `running` |
| `resume` 连续报多轮 | 消费方以为反复放行 | 只报一条，随后回 `running` |
| `finalize` 之后一直报 `finalize` | 消费方永久释放资源，新一轮无保障 | 只报一条 |
| `state_since_ms` 用请求时间 | "卡了多久"算出来恒为 0 | 用进入状态的时刻 |
| 没有 `agent_status` 块 | 老实现兼容，但新消费方失去调度信号 | 至少发 `running` |
| 在 header 里塞 `reason`/`tools` | 占 header 预算，收益为零 | 放事件通道 |

---

## 10. 参考实现

两个可直接对照的开源实现：

| Harness | 仓库 | 语言 | 安装 |
|---|---|---|---|
| Pi | https://github.com/Eric1481/pi-agenthint | TypeScript | `pi install npm:pi-agenthint` |
| Hermes | https://github.com/dachaimahogany/hermes-agent-hint | Python | `hermes plugins install agent-hint`（官方 catalog） |

Hermes 的活跃开发分支另有一份镜像：https://github.com/liteboy-bit/hermes-agent-hint

### 10.1 关键代码位置

**Pi**（TypeScript）

| 文件 | 看什么 |
|---|---|
| [`src/hint-schema.js`](https://github.com/Eric1481/pi-agenthint/blob/main/src/hint-schema.js) | `AGENT_STATES` 枚举定义 |
| [`src/hint-build.js`](https://github.com/Eric1481/pi-agenthint/blob/main/src/hint-build.js) | `buildAgentHint()` 里的状态折叠与 `agent_status` 构造 |

**Hermes**（Python）

| 文件 | 看什么 |
|---|---|
| [`_builder.py`](https://github.com/dachaimahogany/hermes-agent-hint/blob/main/_builder.py) | `request_hint()`：内部状态 → 四值的折叠 |
| [`_state.py`](https://github.com/dachaimahogany/hermes-agent-hint/blob/main/_state.py) | `note_call()`：`finalize` 只描述一条请求的实现 |

> 引用用**文件 + 函数名**而不是行号：行号会随提交变动，函数名不会。

### 10.2 版本说明

四值契约（`running / pause / resume / finalize`）随两个插件的**下一版**发布：
当前 GitHub `main` 上是上一版（五值 + `tool`/`suspend`）。适配时以本文档为准，代码对照等新版发布后即可。

### 10.3 真机验证结果

真实 agent 进程 + mock provider，各 20+ 请求：

| | 观测到的状态序列 |
|---|---|
| Pi | `running → running(工具中) → pause → resume → running → finalize` |
| Hermes | 同上 |


---

## 11. 一页纸总结

```
agent_status: { state, state_since_ms }

state ∈ { running, pause, resume, finalize }

running  = 正常干活（工具执行也算）
pause    = 有人在等
resume   = 刚被放行（只发一条）
finalize = 这次结束了（只发一条）

内部有 tool / suspend / idle 之类，出口折叠掉。
header 只带这两个字段；reason / tools 走事件通道。
消费方：缺失按 running，未知值忽略，不当强信号。
```
