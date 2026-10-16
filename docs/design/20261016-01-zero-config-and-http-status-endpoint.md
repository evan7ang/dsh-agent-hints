# 设计：DSH 内联增量移植 —— 零配置继承与 HTTP 状态端点

> Status: v1 (2026-10-16)。背景见本地交接材料 `docs/handoff-dsh-inline-history.md`（不入库）：本仓基于 DSH 内联侧阶段 1（c10f555）抽取，内联侧此后合入的 !13（HTTP 端点发射）与 !14（零配置继承）未随抽取携带。本文记录两轮增量的移植设计；参考实现为 DSH 仓 `feat/agent-hints-graceful-config` 的 `ed03471` 与 `feat/agent-hints-status-endpoint` 的 `66c7821`。既有 v1 设计见 [docs/design.md](../design.md)，本文不重复其协议形状与词汇定义。

## 1. 目标与边界

- **零配置继承（!14）**：`baseURL`/`apiKeyEnv` 降为纯覆盖层——未配置时继承 DSH 本体回退链（`$DEEPSEEK_BASE_URL` → 公共默认 `https://api.deepseek.com`；凭据引用默认 `DEEPSEEK_API_KEY`，credentials 服务优先、env 回退）。消除"装了插件但没配就告警"的评测噪音，**零配置即激活**。已提供但非法的值仍在组合期抛错（field path），不在请求中途静默降级。
- **HTTP 端点发射（!13）**：状态通道增加 `HttpStatusSink`——POST `StatusEvent` 到调度端点（Motor 侧 `POST {origin}/agent-status` 对接约定）。与 JSONL `statusSink` 双 sink 并存、同发射序；串行队列保序 + 有界重试（200/400/800ms）+ 5s 超时 + 重试耗尽告警丢弃不阻塞。
- **阶段 1 细节核对结论**：hint.ts/status.ts 逻辑体与 DSH 内联最终形态逐字一致（`step/start` 口径、并行工具 `running` 等最后一个、`agent:<tool>` 命名与 child FIFO、`turn/end(completed)` finalize），差异仅为注释措辞与模块名（抽取时主动适配），无需回移。
- **不改变**：hint 协议形状、`X-Agent-Hint` 头编码、wire body 零 hint 字段约束、`deepseek-hint` 路由结构。

## 2. 零配置继承（!14）

### 2.1 继承链

```text
baseURL:    插件行 config.baseURL（覆盖）→ $DEEPSEEK_BASE_URL（官方 trusted-env 旋钮）→ https://api.deepseek.com
apiKeyEnv:  插件行 config.apiKeyEnv（覆盖）→ $DEEPSEEK_API_KEY_ENV（引用名覆盖）→ "DEEPSEEK_API_KEY"
```

- 官方 `llm-deepseek` 适配器的 settings 段 `baseURL` **不可跨插件读取**（settings 段读取注册方私有，无接缝），故继承链只覆盖公共回退源。端点/凭据事实由 DSH 宿主（启动环境 + credentials 服务）持有，插件行配置成为逐字段覆盖层。
- `apiKeyEnv` 继承的是**凭据引用名**（env 变量名），实际取值仍每请求解析：credentials 服务优先、`process.env` 回退——该路径已存在（`resolveApiKey`），不改动。
- `normalizeConfig(undefined | null)` 不再返回 `undefined`（也不存在 inert 降级路径——本仓抽取时未含 `dbcf6b3` 的优雅降级中间形态），而是返回继承后的完整配置；`apply()` 检测 `config === undefined || null` 时 info 提示继承事实（端点 + 凭据引用），不告警。

### 2.2 校验语义

覆盖层的校验规则不变：提供了但非法（如 `baseURL: 'not-a-url'`、`apiKeyEnv: ''`）仍在组合期抛错；继承值非法（如 `$DEEPSEEK_BASE_URL` 不是 http(s)）同样抛错——组合期暴露，请求路径零失败分支。

## 3. HTTP 端点发射（!13）

### 3.1 配置词汇

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `statusEndpoint` | `string`（http(s) URL） | 显式端点全 URL；优先于 `statusAuto` 推导（非默认路径或独立状态服务场景） |
| `statusAuto` | `boolean`（默认 `false`） | 从 `baseURL` origin 推导 `<origin>/agent-status`（Motor 对接约定）；`baseURL` 带路径（如 `/v1`）时剥离 |

端点解析优先级：`statusEndpoint` ?? (`statusAuto` 推导) ?? 无。任一 sink 存在即激活状态通道 observer；`statusSink` 与 HTTP sink 可并存。

### 3.2 HttpStatusSink 行为契约

- **保序**：单实例持有串行 promise 队列，`send()` 入队即返回；重试期间后续事件不越过失败事件。
- **有界重试**：失败按 200/400/800ms 退避重试（共 4 次尝试）；5s `AbortSignal.timeout` 防悬挂。
- **耗尽丢弃不阻塞**：重试耗尽 warn 一次并丢弃该事件，队列继续流动——卡死的调度端点不得拖住 agent。
- `drain()` 供测试/teardown 等待队列排空；`send()` 是网关客户端替换的接缝。
- 与 JSONL sink 同一 `emit` 接缝顺序调用：双 sink 收到的序列逐事件一致（e2e 断言）。

## 4. e2e 扩展

- stub 增加 `--status-out <file.jsonl>`：接收 `POST /agent-status`，载荷逐行落盘（JSONL），充当 Motor Phase 4 调度端点替身；不可解析载荷返回 400。
- e2e overlay 增加 `statusAuto: true`（保持显式 `baseURL`/`apiKeyEnv` 覆盖）；runner 等 finalize 事件落盘后，capture-check 改对 HTTP 收到的序列断言，另比较文件 sink 与 HTTP sink 序列逐事件一致。
- 零配置继承通过单测覆盖（env 注入 `$DEEPSEEK_BASE_URL`）；e2e scratch profile 保持显式配置以固定抓包目标，不测继承路径。

## 5. 影响面与验证

- 模块：`src/config.ts`（继承链 + 状态端点字段）、`src/status.ts`（HttpStatusSink）、`src/index.ts`（继承提示 + 双 sink 组合 + `STATUS_ENDPOINT_PATH`）、`e2e/stub-server.mjs`、`e2e/run.sh`、`e2e/e2e.patch.yml`、`test/apply.test.mjs`、`test/status.test.mjs`。
- 验证：`npm run typecheck && npm run build && npm test` + `bash e2e/run.sh`（涉及 wire 行为与插件接线，必跑）。
