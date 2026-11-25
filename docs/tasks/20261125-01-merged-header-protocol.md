# 任务：两仓合并与 X-Agent-Hint 协议归一化

> 设计见 [20261125-01-merged-header-protocol](../design/20261125-01-merged-header-protocol.md)。本文件记录实施路径、进展与验证结果。

## 目标

把 `dsh-agenthint` 的能力并入本仓，并把 wire 协议归一化为四块 `X-Agent-Hint` header；本仓原有带外状态通道与范围外字段移除。

## 实现路径

1. **依赖与工具链**：按 dsh-agenthint 的 peer/dev 依赖重建 `package.json`（DSH 0.2.2-rc.1、cordis ~4.1.0、schemastery ~3.19.0），改用 `tsc -b` 双 project（host/client）+ esbuild client bundle；`npm run check` 串起类型检查、测试、包检查。
2. **wire 模块**：`src/hint.ts` 重写为归一化类型、`buildOrdinaryHint` / `buildManageHint`、`encodeAgentHintHeader` 与 `deriveServingFacts`（去掉 state/agent_status）；`src/cache.ts` 输出 `{type, ttl_s, msg_offset}`。
3. **控制面**：`src/lifecycle-bridge.ts`、`src/control-client.ts`（manage 请求改 header 承载）、`src/archive-observer.ts`、`src/composing-service.ts` 从 dsh-agenthint 移植并适配。
4. **数据面**：`src/chat-adapter.ts`（dsh-agenthint 为主，去 body `agent_hint`、改 header、吸收 `msg_offset`/`prefixTokens`）；`src/adapter.ts`（Messages 扩展官方适配器，AsyncLocalStorage + `resolveAuth` 注入 header）；`src/extension.ts` 降为 accept 记账。
5. **配置与入口**：`src/config.ts` schemastery（新增 priority/cacheControl，provider 默认 `deepseek-hint`）；`src/index.ts` 合并注册、继承、trace、热更新。
6. **浏览器端**：`src/client/` 移植打字观察器；RPC 命名 `agentHintSignals`。
7. **清理**：删除 `status.ts`、`prediction.ts`、旧 `types/dsh.d.ts`、trie 构建脚本与旧测试；e2e 重写。
8. **测试**：迁移 dsh-agenthint 的 24 个测试文件到 header 断言，新增 `tests/derive.spec.ts`、`tests/cache.spec.ts`。
9. **文档**：新增本设计与任务文档；改写 README / 传输 / 可靠性 / 继承 / trace；AGENTS.md 更新目录与约束；NOTICE 补 MIT 归属。

## 验收标准

- `npm run check` 通过（类型、构建、单测、包内容、锁一致性）。
- `bash e2e/run.sh` 通过（DSH 0.2.2-rc.1，断言四块 header、start/append、resume/stop、body 零 hint、辅助请求无 hint）。
- 删除项在代码与文档中无残留（`agent_status`、`prediction`、`statusSink`、`session_control` 旧 wire）。

## 进展与结果

- 依赖安装：710 packages（npm install，rc.1 全套 peer/dev）。
- 类型检查：`tsc -b --force` 0 error。
- 构建：`tsc -b` + `esbuild` 生成 `lib/types/*` 与 `lib/client.js`。
- 单测：24 个测试文件 / 236 项通过（`vitest run`），`node --test tests/trace.test.mjs` 21 项通过；其中 Messages 传输的并发 hint 隔离由 Loader 集成测试覆盖。
- e2e：`bash e2e/run.sh` 全部断言通过。观测到的 header：普通请求 `state=start` / `append`，priority 3/1，cache `ttl_s=600`、`msg_offset=4`；manage `resume`（prefetch）+ 退出时 `stop`（evict，派发后在退出竞争中被取消，stub 未收到，trace 可证）。
- 已知限制：
  - Motor 未跟进时 manage 请求会被现有入口 400 拒绝，优先级准入不生效。
  - 进程退出时 `stop` 可能丢失。
  - 真实浏览器打字触发与真实引擎 KV 动作未验收。
  - 本机全局 `dsh` 为 0.2.2-alpha.2，与合并后的 peer 版本不匹配；e2e 使用 `~/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1`。
