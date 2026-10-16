# 任务：DSH 内联增量移植 —— 零配置继承（!14）与 HTTP 状态端点（!13）

> 设计依据：[20261016-01-zero-config-and-http-status-endpoint](../design/20261016-01-zero-config-and-http-status-endpoint.md)。参考实现：DSH 仓 `ed03471`（!14）、`66c7821`（!13）。

## 目标

1. `normalizeConfig` 变为纯覆盖层：`baseURL` 继承 `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com`；`apiKeyEnv` 继承 `$DEEPSEEK_API_KEY_ENV` → `DEEPSEEK_API_KEY`；零配置激活，激活时 info 提示；provided-but-invalid 仍组合期抛错。
2. 状态通道增加 HTTP sink：`statusEndpoint`/`statusAuto` 配置；`HttpStatusSink` 串行保序 + 有界重试（200/400/800ms）+ 5s 超时 + 耗尽告警丢弃；与 JSONL `statusSink` 双 sink 同发射序。
3. e2e：stub 增加 `POST /agent-status` 接收器；overlay 配 `statusAuto: true`；双 sink 序列一致性断言。

## 验收标准

- [ ] `normalizeConfig(undefined)` 返回继承配置（env 注入 `$DEEPSEEK_BASE_URL` 时取该值，否则公共默认）；`apiKeyEnv` 默认 `DEEPSEEK_API_KEY`；`{ baseURL: 'not-a-url' }`、`apiKeyEnv: ''` 抛 field-path 错误。
- [ ] 无配置 `apply()` 注册适配器并 info 提示继承事实；显式配置时不提示。
- [ ] `statusAuto: true` 从 `baseURL` origin 推导 `<origin>/agent-status`（剥离路径）；显式 `statusEndpoint` 覆盖推导；两者皆缺时仅 join tracking。
- [ ] `HttpStatusSink`：发射序保序；失败重试后成功保序；耗尽 warn 一次丢弃且后续事件继续流动。
- [ ] 双 sink e2e：HTTP 收到序列与文件 sink 序列逐事件一致；e2e 全流程 PASS。
- [ ] `npm run typecheck && npm run build && npm test` 全绿；`bash e2e/run.sh` PASS。

## 实现路径

1. `src/config.ts`：继承链函数 + `statusEndpoint`/`statusAuto` 字段与校验 + `normalizeConfig` 覆盖层化。
2. `src/status.ts`：新增 `HttpStatusSink`。
3. `src/index.ts`：`STATUS_ENDPOINT_PATH` + 继承 info 提示 + 双 sink 组合。
4. 测试：`test/apply.test.mjs`（继承/激活/端点推导）、`test/status.test.mjs`（HTTP sink 三态）。
5. e2e：`e2e/stub-server.mjs` 接收器、`e2e/run.sh` 等待 finalize + 双 sink 比对、`e2e/e2e.patch.yml` 加 `statusAuto: true`。

## 进展与结果

- 2026-10-16：设计建档；阶段 1 细节核对完成（hint.ts/status.ts 逻辑体与 DSH 内联最终形态逐字一致，已随抽取携带，无需回移）。
- 2026-10-16：实施完成（config.ts 继承链 + statusEndpoint/statusAuto、status.ts HttpStatusSink、index.ts 继承提示与双 sink 组合、两处测试、e2e 三件套）。
- **验证结果（全部通过）**：
  - `npm run typecheck` ✔ `npm run build` ✔ `npm test`：34 pass / 0 fail（原 28 + 新增 6：零配置激活、继承链归一化、端点推导/覆盖/默认关、HTTP sink 保序/重试/耗尽丢弃）。
  - `bash e2e/run.sh` PASS：2 个主线请求带 `X-Agent-Hint`（call_index 1→2、body 零泄漏）、1 个辅助请求不带、状态 sink 3 事件/1 会话、**文件 sink 与 HTTP 端点序列逐事件一致（3 事件）**。
- 验收标准全部达成，无剩余限制；`lib/` 构建产物已重建，与 `src/` 同批待提交。
