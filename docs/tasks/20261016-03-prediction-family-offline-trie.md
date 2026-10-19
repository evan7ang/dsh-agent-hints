# 任务：prediction 全族字段（离线 trie + 静态回退）

> 设计依据：[20261016-03-prediction-family-offline-trie](../design/20261016-03-prediction-family-offline-trie.md)。状态：**规划完成，待评审后实施**。

## 目标

1. `src/prediction.ts`：trie 加载/容错、工具序列最长前缀 lookup、逐字段静态回退（p90/mean 口径、样本门槛）。
2. `src/hint.ts` 构造器填充 `prediction` 块（X-Agent-Hint 通道不变，body 零泄漏不变）。
3. `src/config.ts` 新增 `predictionTrie`/`predictionStatic`/`predictionMinSamples`/`expectedResumeS`；`src/status.ts` pause/suspend 事件携带 `expected_resume_s`（触发源未接入不激活）。
4. `scripts/build-prediction-trie.mjs` 离线构建器：DSH 会话日志 → trie JSON。

## 验收标准

- [x] 配置 `predictionStatic` 后主线请求 `prediction` 块始终发射（标量字段静态值）；配置 trie 且命中时逐字段替换为分布值；`next_action` 仅 trie 命中出现。
- [x] 未配置任何 prediction 来源的部署 wire 行为与 v0.2.1 逐字节一致（回归断言：apply 单测 + capture-check 移除 prediction 缺省断言改为按需断言）。
- [x] trie 坏文件/未命中/样本不足逐字段回退，不抛错、不阻塞请求路径（loadPredictionTrie 容错 + resolvePredictionBlock 逐字段回退，均有单测）。
- [x] 构建器对样例会话日志产出符合设计的 trie JSON（字段/聚合口径对照设计文档 §1 表；summarizeSession/buildTrie 单测覆盖 latency/output/interval/remaining/转移概率与 p90/mean 口径）。
- [x] 单测覆盖 lookup 三态、回退合成、发射形状；e2e 增加静态 prediction 断言（capture-check 校验 prediction 块为配置的静态值）。
- [x] `npm run typecheck && npm run build && npm test` 全绿（49 pass / 0 fail，原 34 + 新增 15）；`bash e2e/run.sh` PASS。

## 实现路径

1. `src/prediction.ts`（类型 + lookup + 回退）→ 2. `hint.ts` 增量 → 3. `config.ts` 新词汇 → 4. `status.ts` expected_resume_s 挂点 → 5. `scripts/build-prediction-trie.mjs` → 6. 测试与 e2e → 7. README 协议章节 + 版本号。

## 前置核对（实施期第一项）

- [x] usage 字段口径：会话日志 `assistant/message` 事件 `data.usage.outputTokens`（TokenUsage 形状，`inputTokens`/`outputTokens` 必有；跨 attempt 累加的口径见 harness `bundle/headless/src/json-stream.ts`）。
- [x] `step/end` 可用：会话格式含 `step/end`（`session-format-v0-to-v1/src/payload-validation.ts:199`，coordinatePair 数据），`latency_ms` 取 step/start→step/end 时间差。

## 进展与结果

- 2026-10-16：dynamo/NAT 参照核实（prediction_trie 机制、OptimizableField 静态兜底）；字段↔数据源↔口径对照完成；四项决策与需求方确认（离线 trie / 预测→静态回退 / 工具序列键 / expected_resume_s 配置传值）；设计建档，待评审。
- 2026-10-16：实施完成。新增 `src/prediction.ts`（trie 加载容错/最长前缀 lookup/逐字段回退，`remaining_calls` 支持 0 值语义）、`scripts/build-prediction-trie.mjs`（会话日志重放 → 前缀 trie → 分布聚合，minCount 剪枝）、`StatusObserver.emitPause` 接缝（配置传值 `expected_resume_s`，无仓内触发源）；`hint.ts`/`config.ts`/`adapter.ts`/`index.ts` 对应增量；README×2 配置表补齐 !13/!14/!15 三轮词汇并同步 prediction 章节；版本 0.3.0。
- **验证结果（全部通过）**：typecheck/build ✔；单测 49 pass / 0 fail；`bash e2e/run.sh` PASS——主线请求 prediction 块 = 配置静态值、body 零泄漏、辅助请求不带、双 sink 序列一致。
- 剩余限制（设计文档 §6 已声明）：trie 单 `agent_type` 分区；`next_action` 无静态语义（仅 trie 命中出现）；`emitPause` 无仓内触发源（业务回调接缝）；trie 陈旧度由部署侧管理。
