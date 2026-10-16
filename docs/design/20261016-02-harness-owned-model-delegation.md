# 设计：提示注入挂点迁移 —— 复用 DSH 本体模型，插件零传输所有权（v3）

> Status: v1 (2026-10-16)。需求：插件不再持有/配置 `baseURL`/`apiKey`/模型——这些完全由 DSH 本体完成；插件消费**本体已配置好的模型路由**，只负责在 wire 上添加 Agent Hint。这是交接材料 §4「harness 上游能力诉求」的插件侧落地：不修改 harness 源码，覆盖**任意**默认模型路由（`deepseek-official` 与 pi-ai/ai-gateway 等）。前置设计见 [docs/design.md](../design.md)（v1，own-route 架构）与 [20261016-01](20261016-01-zero-config-and-http-status-endpoint.md)（零配置继承，被本设计取代其 baseURL/apiKeyEnv 部分）。

## 1. 可行性依据（harness 源码核实）

| 接缝 | 事实 | 位置 |
| --- | --- | --- |
| stream 瀑布拦截 | `ctx.on('llm/stream', (options, next) => …)` 公开包裹**每一次**流式模型调用；`options` 携带 `provider`/`model`/`sessionId`/`purpose`，LOOP 构造的请求 deep-frozen（只读不写） | `packages/llm/llm/src/index.ts:60-72,1115-1124` |
| 会话/用途可见 | `GenerateOptions.sessionId`、`GenerateOptions.purpose?: 'compaction' | 'session-title'` —— 挂点层可区分主线与辅助调用 | `packages/llm/llm/src/types.ts:453-492` |
| 官方路由 fetch | llm-deepseek 两个协议适配器直接调**全局 `fetch`**（headers 内联构造，无扩展点） | `llm-deepseek/src/protocols/chat-completions/adapter.ts:330`、`messages/adapter.ts:122` |
| pi-ai 路由 fetch | 同样走全局 `fetch`（discovery/stream） | `llm-pi-ai/src/discovery.ts:326` 等 |
| 不能做什么 | `adapters` 注册表私有，`listProviders()` 只回元数据副本——**拿不到官方适配器实例去包装**；settings 段读取注册方私有；`DUPLICATE_ADAPTER` 阻止同路由二次注册 | `llm/src/index.ts:337,461-473,424-431` |

结论：在适配器层包装官方适配器不可行（无实例接缝）；在 fetch 层注入可行，但 fetch 层看不见会话——**需要瀑布层提供会话关联**。两层各取所长。

## 2. 架构：双层插桩（瀑布监听 + fetch 注入）

```text
agent loop ── llm.stream({provider:'deepseek-official', model, sessionId, …})
                       │
                       ▼
   ① 瀑布监听（本插件注册 ctx.on('llm/stream')）
      主线调用（有 sessionId 且无 purpose）→ 计算 AgentHint（复用 hint.ts + 会话日志派生，不变）
      → 返回上下文保持的迭代器包装：每次惰性 pull 重建 AsyncLocalStorage 上下文
                       │ next() 内部进入官方适配器，原样构造 URL/headers/body/key
                       ▼
   ② fetch 注入（本插件激活时装一次）
      ALS 上下文存在 → 追加 x-agent-hint 头（base64url，编码不变）
      否则原样透传；body 永不改动
                       │
                       ▼
              DSH 本体配置的模型端点（任意路由）
```

### 2.1 层 ①：瀑布监听（会话感知 + hint 计算）

- 注册 `ctx.on('llm/stream', (options, next) => …)`；`options.sessionId` 存在且 `options.purpose` 缺省才注入（辅助调用天然不带 hint，协议 §4/§5 口径与 v1 一致）。
- hint 计算完全复用现状：`deriveServingFacts`（会话日志派生 call_index/epoch）、`derivation.join`（firehose 跟踪）、词汇配置（agentType/priority/cacheControl）——只把"装配进自己适配器的请求"改为"装配进 ALS 上下文"。
- **惰性 pull 问题**：`next()` 返回的 AsyncIterable 可能延迟到首次 pull 才真正发 fetch（async generator 前导代码在首次 pull 时执行，而 pull 发生在消费者上下文里，不在监听器栈内）。对策：包装迭代器，每次 `next()`/`return()`/`throw()` 都在 `als.run(store, …)` 内转发——标准上下文保持模式，无论适配器 eager 还是 lazy 发请求都能覆盖。

### 2.2 层 ②：fetch 注入（传输装饰）

- 激活时对 `globalThis.fetch` 做一次性补丁（有 `effect` 释放还原）；仅当 ALS 上下文存在时追加 `x-agent-hint` 头，其余请求零感知。
- body/URL/认证/模型全部来自官方适配器——**插件对传输零所有权**。
- 已知边界（记入协议边界清单）：上下文窗口内的杂散 fetch（如同链路的遥测）也会带上 hint 头；对不理解该头的端点无害（与 v1「未知端点视其为未知头」同理）。

### 2.3 状态通道迁移

- `statusSink`（JSONL）与 `statusEndpoint`（HTTP sink，!13 刚移植的 `HttpStatusSink`）**原样保留**。
- `statusAuto` 的推导锚点从"插件自己的 `baseURL`"改为继承链 `$DEEPSEEK_BASE_URL` → 公共默认（插件不再有 baseURL 配置项）；部署若通过 llm-deepseek settings 段覆盖了本体端点，`statusAuto` 推导会偏离，此时应显式配 `statusEndpoint`——设计文档与 README 明确此边界。

### 2.4 删除面（v3 相对 v0.2.0+!13/!14）

- 删 `src/adapter.ts`（538 行独立 chat-completions 传输：序列化/SSE/错误码映射/头注入）与 `PROVIDER_ROUTE`/`deepseek-hint` 注册。
- 删配置字段：`baseURL`、`apiKeyEnv`（及 `DEFAULT_API_KEY_ENV`/继承函数）、`models`/`defaultContextWindow`/`defaultMaxTokens`/`thinking`/`reasoningEffort`（本为自建传输服务的词汇，全部归还 DSH 本体）。
- 保留配置：`agentType`、`priority`、`cacheControl`、`statusSink`、`statusEndpoint`、`statusAuto`、`subagentToolNames`。
- 保留模块：`hint.ts`（编码）、`status.ts`（observer + 双 sink）、`config.ts`（瘦身后的覆盖层）。

## 3. 兼容与发布

- **破坏性变更**：v0.3.0。挂载 id `agent-hints` 不变；部署侧从 `agent-default-model.provider: deepseek-hint` 改回本体路由（如 `deepseek-official`），并删除插件行的 `baseURL`/`apiKeyEnv` 配置。README 同步改协议形状（hint 头由"自建路由"改为"瀑布+fetch 装饰"产出）。
- **上游正解的关系**：§4 的 `GenerateOptions.agentHint` 上游词汇仍是长期正解；本设计是其落地前的插件侧桥接，上游落地后可把层 ①② 替换为对齐实现，hint/状态计算不变。
- **否决的备选**：同路由替换注册（`DUPLICATE_ADAPTER` 且拿不到原实例，需重实现传输=回到 own-route）；上游改造（越仓）。

## 4. 验证方案

- **单测**：瀑布监听（主线注入/辅助跳过/无会话跳过）、ALS 迭代器包装（惰性 pull 上下文保持）、fetch 注入（有/无上下文透传）；hint/status 既有测试不动。
- **e2e（免 key）**：部署绑定本体路由 `deepseek-official`，用 `$DEEPSEEK_BASE_URL`/`$DEEPSEEK_API_KEY` 把官方适配器指向本地 stub（stub 不变）；断言：主线请求带 `X-Agent-Hint`（身份/词汇正确）、body 零 hint 字段、辅助请求不带、状态事件双 sink 一致。**这同时验证 ALS 穿透官方适配器内部这一最大风险点。**
- 门禁：`npm run typecheck && npm run build && npm test` + `bash e2e/run.sh`。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| ALS 不穿透官方适配器内部（重试/内部调度换栈） | e2e 实证；迭代器包装覆盖每个 pull；llm-retry 重试重入 llm/stream → 上下文每尝试重建 |
| 杂散 fetch 带头（仅 ALS 存在性门控） | 记录为协议边界；如需收紧可在注入前校验 URL 路径为 `/chat/completions` 等模型端点特征（v3 先不做，保持最小假设） |
| 瀑布监听器顺序与其他插件（llm-retry 等）耦合 | 只读不写 options、只包装迭代器，语义与既有不变式兼容；e2e 覆盖 |
| statusAuto 锚点弱化（settings 段覆盖场景） | 文档明确 + `statusEndpoint` 显式覆盖路径保留 |
