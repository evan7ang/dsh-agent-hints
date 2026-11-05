# AgentHint `cache_control` 实现指南

> 读者：要在自己的 Harness 里实现 AgentHint `cache_control` 的开发者（DSH / Dify / 其他）
> 目标：照着做完，你的 Agent 在工具等待期间不会再丢掉 KV 缓存。
> 前提：下游消费方（MindIE-Motor）与引擎已支持该字段；不支持时字段会被忽略，不会报错。

---

## 0. 一句话版本

**每个 LLM 请求带一个 header，声明"当前前缀请再留 N 秒"。**

```http
X-Agent-Hint: <base64url(JSON)>
```

```json
{
  "session": {"session_id": "s-123", "agent_type": "dify-agent", "call_index": 3, "epoch": 0},
  "agent_status": {"state": "running", "state_since_ms": 1730000000000},
  "cache_control": [
    {"type": "ephemeral", "ttl_s": 240, "range": {"end": 12, "unit": "message"}}
  ]
}
```

整个字段只做一件事：**告诉下游"这段前缀在接下来 N 秒内还会被复用，别急着淘汰"**。

---

## 1. 端到端数据流

```
你的 Harness
  │  ① 组装消息 → ② 估算 gap → ③ 算 TTL → ④ 编码 header
  ▼
Motor（消费方，路由/编排层）
  │  ⑤ 解析 cache_control → ⑥ 记入声明账本 → ⑦ 翻译成引擎动作
  ▼
Engine（vLLM / vllm-ascend）
     ⑧ 按优先级保留 KV 块，TTL 到期释放
```

**你只负责 ①②③④。** ⑤–⑧ 由消费方完成；消费方缺席时，header 被静默忽略。

---

## 2. 字段规范

### 2.1 `cache_control`（本文重点）

数组，但**只放一条**：

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `type` | 否 | `"ephemeral"` | 唯一有效值。`"pin"` 已退役，消费方会归一化并告警 |
| `ttl_s` | **是** | 整数秒 | **只有显式给值才会生效**；不给等于没声明 |
| `range.end` | 建议 | 正整数 | 1-based，前缀的最后一个消息下标（含） |
| `range.unit` | 建议 | `"message"` | 唯一支持的坐标单位 |

### 2.2 `range.end` 到底数什么

按**本次请求实际发给模型的逻辑输入**计，顺序是 `[system?] + messages`：

```
[system, user]              → end = 2
[system, user, assistant]   → end = 3
（无 system）[user]          → end = 1
```

**不要**用 append-only 的会话历史长度：压缩、分支、重写都会让"历史长度"和"实际输入"脱节，断点会落到错误位置。

如果本轮带了一个空的 assistant 占位消息（有些框架会发），它不计入。

### 2.3 三个硬约束

| 约束 | 值 | 违反的后果 |
|---|---|---|
| 最小可缓存前缀 | **128 token（一个块）** | 引擎根本不存不足一块的前缀，声明等于空转 |
| TTL 下界 | 60 秒 | 低于下界会被抬到 60 |
| TTL 上界 | 3600 秒 | 高于上界会被截断到 3600 |

> 上界**截断而不是丢弃**：实测不声明时 600 秒间隔命中 0%，声明 3600 秒命中 99.8%。

---

## 3. 十二条语义规则

1. **单断点**。只声明一个位置（当前前缀末尾）。不要发多个。
2. **必须显式 TTL**。`{"type":"ephemeral"}` 不带 `ttl_s` = 不保留。
3. **不续期**。消费方不会因为命中而延长 TTL；**每次请求都要重新声明**。
4. **每请求都发**。空闲期间没有请求，TTL 不会自己续。
5. **`type` 不影响行为**。`pin` 与 `ephemeral` 在消费侧等价；新代码只用 `ephemeral`。
6. **数组可以只发一条**。旧版客户端发两条（`pin` + `ephemeral`），消费方会折叠；新实现不要模仿。
7. **TTL 从"声明生效"起算**，是绝对时间，不是滑动窗口。
8. **前缀必须稳定**。断点之后若还有每轮变化的内容（时间戳、随机 id、轮次计数），缓存会退化为每轮重写。
9. **压缩/分支后当轮不发**。此时前缀已变，声明会把旧前缀错误地留住。
10. **模型或工具集变化后当轮不发**。同样的原因。
11. **header 有大小预算**（建议 ≤ 4 KB）。超预算时优先丢 `prediction`，**最后**才丢 `cache_control`。
12. **失败必须静默**。组装失败就不发，绝不能让请求失败。

---

## 4. TTL 怎么算

### 4.1 公式

```
gap = 下一次暂停的预计时长（秒）
TTL = clamp(gap × 2, 60, 3600)
```

### 4.2 `gap` 的取值优先级

| 优先级 | 信号 | 来源 |
|---|---|---|
| 1 | **下一次工具的预计耗时** | 历史统计：同一工具、同一调用位置的耗时分布 |
| 2 | **最近一次请求间隔** | 上一次响应结束 → 本次请求开始 |
| 3 | **兜底 300 秒** | 没有任何样本时 |

### 4.3 为什么乘 2

实测关系是**二值**的：

| 关系 | 命中率 |
|---|---|
| `ttl > 实际间隔` | 98–100% |
| `ttl ≤ 实际间隔` | **0%** |

临界点精确落在 `1.0×`，而且**短 13% 就全丢**。代价又不对称：估短 = 100% 丢失，估长 = 多占一点显存。

所以 `×2` 的含义是：**容忍实际间隔是预测值的 2 倍**。

### 4.4 参考实现（语言无关）

```python
TTL_MIN_S, TTL_MAX_S, FALLBACK_GAP_S, FACTOR = 60, 3600, 300, 2

def estimate_ttl_s(tool_expected_s=None, interval_ms=None):
    if tool_expected_s and tool_expected_s > 0:
        gap = float(tool_expected_s)
    elif interval_ms and interval_ms > 0:
        gap = interval_ms / 1000.0
    else:
        gap = FALLBACK_GAP_S
    return max(TTL_MIN_S, min(TTL_MAX_S, round(gap * FACTOR)))
```

### 4.5 工具耗时怎么统计

按 **(调用位置, 工具名)** 分组，取 **p90**（不是均值）：

```python
samples[(call_ordinal, tool_name)].append(duration_s)
expected = p90(samples[(ordinal, next_tool)])
```

- 样本 < 3 条时不发布，走优先级 2 或 3
- 只保留最近 20 条，避免"上周的行为"影响当前判断
- 不知道下一个工具是谁时，用**同位置的历史间隔**兜底

---

## 5. 什么时候不发

| 场景 | 发不发 | 原因 |
|---|---|---|
| 普通轮次 | ✅ 发 | — |
| 压缩（compaction）后当轮 | ❌ 不发 | 前缀已重写 |
| 分支/回滚后当轮 | ❌ 不发 | 前缀已变 |
| 模型或工具集变化后当轮 | ❌ 不发 | 缓存键失效 |
| 前缀 < 128 token | ❌ 不发 | 不足一块，引擎不存 |
| 拿不到消息数量 | ❌ 不发 | 断点位置未知，宁可不猜 |
| 会话收尾轮 | 🟡 可选 | 之后不会再有请求，发了也浪费配额 |

---

## 6. 实现示例 A：Node / TypeScript（DSH 这类 harness）

### 6.1 组装 header

```ts
const TTL_MIN = 60, TTL_MAX = 3600, FALLBACK = 300, FACTOR = 2;

export function buildCacheControl(opts: {
  logicalMessageCount: number;   // [system?] + messages 的数量
  prefixTokens: number;          // 估算的前缀 token 数
  ttlS: number;
}): Array<Record<string, unknown>> | undefined {
  if (!Number.isSafeInteger(opts.logicalMessageCount) || opts.logicalMessageCount < 1) return undefined;
  if (opts.prefixTokens > 0 && opts.prefixTokens < 128) return undefined; // 不足一块
  if (!(opts.ttlS > 0)) return undefined;                                // 没有 TTL 就没有声明
  return [{
    type: 'ephemeral',
    ttl_s: Math.min(TTL_MAX, Math.max(TTL_MIN, Math.round(opts.ttlS))),
    range: { end: opts.logicalMessageCount, unit: 'message' },
  }];
}

export function encodeHint(hint: unknown): string {
  return Buffer.from(JSON.stringify(hint), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // base64url，无 padding
}
```

### 6.2 前缀 token 估算（无 tokenizer 时）

```ts
export function estimatePrefixTokens(messages: unknown[]): number {
  let cjk = 0, other = 0;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const ch of v) {
        const c = ch.codePointAt(0)!;
        if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef)) cjk++;
        else other++;
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(messages);
  return cjk + Math.ceil(other / 4);
}
```

### 6.3 挂载点

```
provider 请求前钩子（拿到最终 payload + 消息列表）
  → 记录 logicalMessageCount 与 prefixTokens
  → 在发请求前把 X-Agent-Hint 塞进 headers
```

要点：**只在 header 上加字段，绝不改 body**。body 一变，前缀就变，缓存全废。

### 6.4 与 DSH 的字段映射

| AgentHint 字段 | DSH 里的来源（按你实际的上下文对象替换） |
|---|---|
| `session.session_id` | 本次 run / conversation 的稳定 id，**跨请求不能变** |
| `session.call_index` | 本次 run 内第几次 LLM 请求，从 1 开始 |
| `session.agent_type` | 固定标识，例如 `dsh-agent` |
| `agent_status.state` | 调模型时 `running`，执行工具时 `tool` |
| `range.end` | 本次请求的**逻辑输入条数**（`[system?] + messages`，不含空 assistant 占位） |
| `ttl_s` | 见 §4：下一次工具预计耗时 → 否则最近间隔 → 否则 300，乘 2 后钳制 |

两个容易踩的点：

1. **不要用会话历史长度算 `end`**。压缩/分支之后，历史长度和实际输入会脱节，断点就落错位置。以"这次真正要发出去的消息"为准。
2. **工具耗时要在工具结束时结算**，不要在工具开始时用常量估算。用 `(调用位置, 工具名)` 分组取 p90，样本不足 3 条才退回兜底值。

---

## 7. 实现示例 B：Python / Dify

### 7.1 组装（与语言无关的核心）

```python
import base64, json, time

TTL_MIN_S, TTL_MAX_S = 60, 3600

def build_cache_control(messages, ttl_s, system_present=True):
    """messages: 本轮实际发送的消息列表（不含空 assistant 占位）。"""
    if not isinstance(messages, list) or not messages or ttl_s <= 0:
        return None
    logical = len(messages) + (0 if system_present else 0)
    # 若 system 不在 messages 里而是单独字段，上面 +0 即可；统一成“逻辑输入条数”为准
    if logical < 1:
        return None
    if estimate_tokens(messages) < 128:
        return None
    return [{
        "type": "ephemeral",
        "ttl_s": max(TTL_MIN_S, min(TTL_MAX_S, int(round(ttl_s)))),
        "range": {"end": logical, "unit": "message"},
    }]


def encode_hint(hint: dict) -> str:
    raw = json.dumps(hint, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
```

### 7.2 挂到 Dify 上

Dify 侧有两种落地方式，按你的插件类型选：

| 方式 | 位置 | 备注 |
|---|---|---|
| **模型 Provider 插件** | 构造上游请求时加 header | 最贴近"每个 LLM 请求都带"，推荐 |
| **HTTP 请求节点 / 外部网关** | 在转发层统一注入 | 适合不改 Dify 内核的部署 |

需要采集的两个信号：

1. **上一次模型响应结束 → 本次请求开始** 的时间差（`interval_ms`）
2. **工具节点执行耗时**：在工具调用前后各打一个时间戳，按 `(调用位置, 工具名)` 存最近 N 条

> Dify 的工作流里工具节点是独立节点，最容易拿到的是"节点开始/结束"事件；把它们接进上面的样本表即可。

### 7.3 与 Dify 会话的映射

| AgentHint 字段 | Dify 里的来源 |
|---|---|
| `session.session_id` | 会话 id（`conversation_id`），**必须稳定** |
| `session.call_index` | 本次会话内第几次 LLM 调用（从 1 开始） |
| `session.agent_type` | 固定值，例如 `dify-agent` |
| `agent_status.state` | 运行中 `running`；执行工具时 `tool` |

---

## 8. 自检三步

### 第 1 步：header 合法

```python
hint = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
assert hint["cache_control"][0]["type"] in ("ephemeral", "pin")
assert isinstance(hint["cache_control"][0]["ttl_s"], int)
assert hint["cache_control"][0]["range"]["unit"] == "message"
```

### 第 2 步：消费方收到了

在 Motor 侧日志里应能看到：

```
cache_control declared: session_id=<你的会话> type=ephemeral ttl_s=240
```

看不到说明：header 名字错、编码错、或值没被解析（检查是否走了 body 而不是 header）。

### 第 3 步：真的命中了

工具等待结束后，同一前缀再次请求，看引擎指标：

```
vllm:prefix_cache_hits_total      （应增长）
vllm:prefix_cache_queries_total
```

命中率应接近 100%；如果为 0，按下面的对照表排查。

---

## 9. 常见错误对照表

| 现象 | 最可能的原因 |
|---|---|
| 消费方完全看不到声明 | header 名不是 `X-Agent-Hint`；或 base64 用了标准字母表（应 base64url 且无 padding） |
| 声明被忽略 | `ttl_s` 没给（只给了 `type`） |
| 命中率恒为 0 | TTL 小于实际间隔；或前缀里有每轮变化的内容 |
| 只有第一轮命中 | 只在首轮发了声明（必须每轮都发） |
| 命中率忽高忽低 | 断点落在易变内容之后；检查 `range.end` 是否等于逻辑输入条数 |
| 短会话完全不生效 | 前缀不足 128 token，被最小长度门槛挡掉（符合预期） |
| 声明了但 TTL 明显变短/变长 | 被钳制到 [60, 3600] |

---

## 10. 测试清单

| # | 用例 | 期望 |
|---|---|---|
| 1 | 正常一轮 | header 可解码，`ttl_s ∈ [60,3600]`，`range.end == 逻辑输入条数` |
| 2 | `ttl_s = 0` | 不产生 `cache_control` |
| 3 | 前缀 50 token | 不产生 `cache_control` |
| 4 | 压缩后当轮 | 不产生 `cache_control` |
| 5 | 工具耗时样本 < 3 | 回落到间隔或 300 |
| 6 | 间隔 120s、预计工具 120s | TTL = 240（不是 120） |
| 7 | 预计工具 7200s | TTL = 3600（截断而非丢弃） |
| 8 | 畸形输入（缺字段/类型错） | 不抛错，退化为不发 |

---

## 11. FAQ

**Q：TTL 设大一点是不是更好？**
时间维度上几乎免费（容量才是瓶颈），但要有上限：上界 3600 秒，且声明过量会挤占其他会话的显存。按 `gap × 2` 走就够。

**Q：能不能只发一次，让消费方自己续期？**
不能。消费方不续期，TTL 是绝对时间；空闲期间没有请求，只能靠每次请求重新声明。

**Q：`pin` 还能用吗？**
协议仍接受，但会被归一化为 `ephemeral` 并告警。新代码不要用。

**Q：多个断点有意义吗？**
没有。消费方把数组折叠成"最宽 end + 最长显式 TTL"，第二条不产生任何行为。发一条即可。

**Q：消费方不支持怎么办？**
header 会被忽略，请求正常返回。可以放心上线，不需要能力探测。

---

## 12. 参考实现

| 语言 | 仓库 | 说明 |
|---|---|---|
| TypeScript | `pi-agenthint`（npm） | 单断点、runtime TTL 推导、最小前缀门槛 |
| Python | `hermes-agent-hint` | 同上，含工具耗时 p90 统计 |

两者的 `cache_control` 组装逻辑与本文第 4、6 节一致，可直接对照。
