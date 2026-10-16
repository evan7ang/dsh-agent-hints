# 任务：v3 架构迁移 —— 瀑布监听 + fetch 注入，插件零传输所有权

> 设计依据：[20261016-02-harness-owned-model-delegation](../design/20261016-02-harness-owned-model-delegation.md)。状态：**规划完成，待评审后实施**。

## 目标

1. 插件不再持有 `baseURL`/`apiKeyEnv`/模型目录——传输完全由 DSH 本体（官方适配器或 pi-ai 路由）完成。
2. `llm/stream` 瀑布监听计算 hint 并建立 ALS 上下文；fetch 补丁在 wire 上追加 `x-agent-hint` 头（惰性 pull 每次重建上下文）。
3. 删除 `src/adapter.ts` 与 `deepseek-hint` 自建路由；配置瘦身为 hint 词汇 + 状态通道（`statusAuto` 锚点改继承链）。
4. e2e 改为绑定本体路由 `deepseek-official`（env 指向本地 stub），验证 ALS 穿透官方适配器。

## 验收标准

- [ ] 主线请求（有 sessionId 无 purpose）带 `X-Agent-Hint`：会话身份/词汇与会话日志派生一致；body 零 hint 字段。
- [ ] 辅助调用（purpose=compaction/session-title）与无会话调用不带 hint 头。
- [ ] 部署绑定 `deepseek-official`（DSH 本体模型/凭据）时全链路 PASS；插件行配置不含 baseURL/apiKeyEnv。
- [ ] 状态事件：JSONL 与 HTTP 端点双 sink 序列一致；`statusAuto` 按继承链推导。
- [ ] ALS 惰性 pull 上下文保持有单测覆盖（延迟首 pull 的适配器行为）。
- [ ] `npm run typecheck && npm run build && npm test` 全绿；`bash e2e/run.sh` PASS。
- [ ] README/README.zh 协议形状与配置章节同步 v3；版本 0.3.0。

## 实现路径

1. `src/decorate.ts`（新）：ALS 存储 + 迭代器上下文包装 + fetch 补丁（effect 释放还原）。
2. `src/hint.ts`：编码逻辑不动；`deriveServingFacts` 不动。
3. `src/index.ts`：删路由注册与 apiKey 解析；注册 `ctx.on('llm/stream', …)` + fetch 补丁 + 状态 observer（保留）。
4. `src/config.ts`：删 `baseURL`/`apiKeyEnv`/`models`/`defaultContextWindow`/`defaultMaxTokens`/`thinking`/`reasoningEffort`；`statusAuto` 锚点改 `$DEEPSEEK_BASE_URL` → 公共默认。
5. `src/adapter.ts` 删除；`types/dsh.d.ts` 按新接缝收敛（llm.stream/waterfall、去掉 adapter 合同面）。
6. 测试：apply/status/adapter 三文件改写（adapter.test.mjs 的 wire 用例迁到 decorate 语义）。
7. e2e：run.sh 改 env 指路 + `agent-default-model.provider: deepseek-official`；capture-check 断言不变（含辅助请求不带头）。
8. 文档：README×2、design.md 补 v3 说明（保留 v1 历史）、版本号。

## 风险与核对

- ALS 穿透官方适配器：e2e 实证为门禁项，失败则回退设计评审（不静默降级）。
- `lib/` 与 `src/` 同批提交；破坏性变更记入提交说明。

## 进展与结果

- 2026-10-16：harness 接缝核实（llm/stream 瀑布、GenerateOptions.sessionId/purpose、官方与 pi-ai 全局 fetch、注册表私有不可包装）；设计建档，待评审。
