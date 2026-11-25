# dsh-agent-hints

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的逐请求 Agent Hint 插件：注册一个 provider 路由，其模型请求携带一个结构化的 **`X-Agent-Hint`** 头（UTF-8 JSON，base64url）——会话身份、生命周期状态、二值优先级与缓存声明；会话生命周期驱动有界的 manage 请求。请求体永不携带 hint 字段。

插件注册独立 provider 路由（**默认 `deepseek-hint`**），支持 Chat Completions 与官方 Messages 两条传输；从同级 `llm-deepseek` 路由继承地址、模型目录与凭据引用；并安装宿主侧的 composer 观察器，让浏览器草稿输入可以提前触发 `resume`。

[English](README.md) | 中文 · 合同：[传输](docs/transport.md) · [可靠性](docs/reliability.md) · [配置继承](docs/endpoint-inheritance.md) · [trace](docs/trace.md)

## Wire 契约

只有四块：

```jsonc
// 普通请求：全新会话的首条
{
  "session": { "session_id": "s-1", "parent_session_id": "p-1", "call_index": 1, "epoch": 0, "state": "start" },
  "priority_control": { "priority": { "level": 3, "reason": "user_waiting" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 600, "msg_offset": 10 }
}

// 普通请求：其余全部
{
  "session": { "session_id": "s-1", "call_index": 5, "epoch": 1, "state": "append" },
  "priority_control": { "priority": { "level": 1, "reason": "critical_path" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 300, "msg_offset": 12 }
}

// manage 请求：body 只是占位（{ model, messages: [], stream: false }）
{
  "session": { "session_id": "s-1", "call_index": 5, "epoch": 1, "state": "pause" },
  "context_management": { "manage_request": true,
                          "edits": [{ "type": "offload", "target": "session" }] }
}
```

- `state` 共 6 值：`start` / `append` / `pause` / `resume` / `stop` / `compact`。`start` 在每个全新会话中恰好出现一次，其余普通请求一律 `append`。
- 生命周期动词各占一条 manage 请求：`pause` → `offload`、`resume` → `prefetch`、`stop` → `evict`、`compact` → `evict`，`target` 为 `session`。`compact` 携带被驱逐的旧 epoch。
- 辅助调用（任意非空 `purpose`，如压缩摘要、会话标题）不携带任何 hint。
- 请求体与 provider 原生格式逐字节一致；hint 只存在于请求头。

### 生命周期触发

| state | 触发 |
| --- | --- |
| `start` | 全新（不带历史）会话的首条被接受的普通请求 |
| `append` | 其余普通请求 |
| `pause` | 另一会话的普通请求被接受，且本会话 agent 空闲、在途流结束 |
| `resume` | 带历史/已 pause 会话的下一条普通请求前；或浏览器草稿由空变非空 |
| `stop` | 会话销毁，或成功归档 |
| `compact` | `compaction/end` 且无 error |

### 优先级与缓存

- `priority_control` 随每条普通请求发出：turn 开局请求为 `3` / `user_waiting`，自驱续接为 `1` / `critical_path`。静态 `{ level, reason }` 为常量覆盖；`"omit"` 省略。
- `cache_control` 每条符合条件的普通请求一条 `ephemeral` 声明：`msg_offset` 等于本次 wire 消息条数，`ttl_s = clamp(上次间隔 × 2, 60, 3600)`。压缩当轮、模型/工具集变化、前缀估算不足 128 token 时抑制。静态 `{ ttl_s, msg_offset? }` 覆盖策略；`"omit"` 省略。

## 传输

- **Chat**（默认）：插件自实现的 Chat Completions 适配器逐请求写入请求头，保留角色、工具调用/结果 id 与 reasoning 历史。原生图片/文件明确报 `UNSUPPORTED_CONTENT`，不会静默丢弃。
- **Messages**：官方 `DeepSeekAdapter` 管线（含附件）。它没有 per-request header 钩子，插件用 AsyncLocalStorage 绑定当前请求的 hint，并在 `resolveAuth` 中写入 `x-agent-hint`。宿主日后提供正式钩子时应替换该接缝。

## 安装

构建产物已提交入库（`lib/`），从 GitHub 安装无需构建脚本权限：

```bash
dsh plugin --profile <your-profile> add github:<owner>/dsh-agent-hints#<commit>
```

或在本地构建后安装 tarball：

```bash
npm ci
npm run check
npm pack
dsh plugin --profile <your-profile> add "$PWD"/dsh-agent-hints-0.4.0.tgz
```

需要 Node `^22.19.0 || >=24` 与 DSH **0.2.2-rc.1**。重启实例后把 `agent-default-model.provider` 指向本路由（默认 `deepseek-hint`）。

## 配置

同级 `llm-deepseek` 路由已配置时零配置即可用：地址、模型目录与凭据引用都会继承。下列字段逐项覆盖继承值。

```yaml
- id: agent-hints
  config:
    provider: deepseek-hint        # provider 路由 id（改动需重载）
    transport: chat                # chat | messages
    baseURL: http://127.0.0.1:1025 # 可选；继承 > DSH_AGENT_HINT_BASE_URL > DEEPSEEK_BASE_URL
    apiKeyEnv: MOTOR_API_KEY       # 可选凭据引用；同端点来源可继承
    inheritCredentials: true
    models:
      - id: served-model
        name: Served Model
        contextWindow: 32768
        maxTokens: 4096
    agentHint:
      enabled: true
      priority: dynamic            # dynamic | omit | { level, reason }
      cacheControl: dynamic        # dynamic | omit | { ttl_s, msg_offset? }
      sessionControl:
        enabled: true
        pluginTriggers: true       # 宿主侧 composing Remote 与公开归档观察
        pendingOpAwaitMs: 2000
        controlTimeoutMs: 5000
        retries: 1
      trace:
        enabled: true
        maxRecords: 2000
        writeToSession: true
```

`agentHint.enabled: false` 时路由退化为普通模型路由，不发 hint、不做生命周期控制。非法取值在组合期带字段路径报错。

## 消费端要求

请求头是增量且对不认识的端点无害，但生命周期动词与优先级准入只有在消费端解析归一化 header 后才生效：

1. 在请求校验前解码 `X-Agent-Hint`，`context_management.manage_request` 为真时允许空 `messages`。
2. 把 `session.state` 映射到消费端自己的生命周期词表（`start`/`append` 不触发上下文动作）。
3. 把 `context_management` 映射到引擎可见形态；优先级从 `priority_control.priority.{level, reason}` 读取。
4. `cache_control.{ttl_s, msg_offset}` 取代旧的 `{ttl, msg_offset}` 声明。

在消费端跟进前，普通请求仍会携带会话身份与缓存声明；manage 请求会被拒绝并记录为失败。

## 验证

```bash
npm run check                    # 类型检查、构建、单测/集成测试、包内容检查
bash e2e/run.sh                  # 免 key wire e2e（DSH 0.2.2-rc.1）
```

e2e 会把本包安装到临时 profile，跑两轮 headless（全新会话，再收养同一会话），对着捕获 stub 断言 header 形状、`start`/`append`、`resume` manage 请求、已派发的 `stop`、占位 body 与无 hint 的标题请求。浏览器打字触发由组件测试覆盖；真实浏览器验收仍待执行。

## 许可

MulanPSL-2.0。部分代码来自 MIT 许可的 `dsh-agenthint` 插件与 DeepSeek Harness AgentHint 集成分支，见 [NOTICE](NOTICE)。
