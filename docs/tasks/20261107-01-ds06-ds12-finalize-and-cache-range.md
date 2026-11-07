# 任务：修复外部框架失败用例 DS-06 / DS-12（finalize 会话级化 + 静态 cacheControl range 补全）

> 状态：已完成（2026-11-07）。设计依据见 [../design/20261107-01-session-scoped-finalize-and-cache-range-fill.md](../design/20261107-01-session-scoped-finalize-and-cache-range-fill.md)。

## 目标

修复外部测试框架（`/home/evan/agent-hint-harness-testing`，报告 `docs/DSH-失败用例原因分析_20261107.md`）对本轮 DSH 子集报出的两条失败：

- **DS-06**：事件通道 `finalize` 每个 completed turn 发一次（判据要求会话级：每 `(session_id, source)` 子流至多一条且为最后一条）。
- **DS-12**：静态 `cacheControl` 覆盖条目缺 `range`（判据要求每条声明带 `range.end ≥ 1` 且 `unit === "message"`）。

## 实现路径

1. `src/status.ts`：`turn/end` 只清 pending/pauseSince 不再发 `finalize`；新增 `StatusObserver.onDispose()` 在 `session/disposed` 时发唯一一条 `finalize`。
2. `src/index.ts`：状态通道激活时注册 `session/disposed` 监听（类型桩 `types/dsh.d.ts` 已具备该事件签名，无需扩展）。
3. `src/adapter.ts`：静态 `cacheControl` 条目未显式给 `range` 时按本次 wire 消息条数补 `{ end, unit: 'message' }`；显式给的逐字尊重。
4. 单测同步：`test/status.test.mjs`（completed turn 不发、disposal 发且最后一条）、`test/apply.test.mjs`（接线与激活条件）、`test/adapter.test.mjs`（补 range / 显式 range / null）。
5. e2e 断言语义同步（`e2e/capture-check.mjs`、`e2e/run.sh` 注释）。

## 验收标准

- `npm run typecheck && npm run build && npm test` 全绿。
- `bash e2e/run.sh` 全绿：状态事件流每会话至多一条 `finalize` 且为最后一条；静态覆盖形态可由框架 overlay 复现补全后的 `range`。
- 对照 DS-06 / DS-12 判据逐条核对语义吻合。

## 进展与调整

### 2026-11-07 实施

- DS-06 / DS-12 按上述路径完成。
- **验证中发现前置阻断（harness 2026-11-06 升级 0.2.2-alpha.2 的词表漂移），先行修复**，详见设计文档 §3：
  - `settings.yaml` 一次性导入导致 e2e 模型绑定静默失效 → 改走 patch overlay（`agent-default-model` 行进 `e2e/e2e.patch.yml` 与 `e2e/e2e-compaction.patch.yml`）。
  - 工具结果改为 `role: 'tool'` 独立消息 → `hint.ts` 导出 `toolResultCallId()` 双形态提取（status.ts 复用），`serializeMessages` 增加 tool 角色分支；`types/dsh.d.ts` 类型桩同宽扩展。
  - `subagent` 工具转为 background-only → e2e 流程与断言重写（根 5 请求；stub 剧本改 `run_in_background: true`，join 断言 `async`）。
- 版本 0.3.0 → 0.3.1（`package.json` / `package-lock.json` / 适配器 UA），wire 行为变化便于框架报告区分。

### 验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过（lib/ 产物已同步）。
- `npm test`：**73/73 通过**（新增：completed turn 不发 finalize、disposal 发且最后一条、无等待会话 disposal 发、双形态配对 ×2、tool 角色序列化、静态 cache 补 range/显式 range 尊重）。
- `bash e2e/run.sh`：**PASS**（真实 DSH 0.2.2-alpha.2）：
  - 主场景：7 条带 hint 主请求（根 call_index 1→5 跨 background 委托与会话收养，子 1→2），running/resume、优先级 3/1、动态 cache（含重启后抑制）逐字段通过；spawn lineage `join: 'async'`。
  - 状态事件流：根 `pause→running→pause→pause(绑定 child)→running→finalize(run1 处置)→finalize(run2 处置)`，子 `pause→running→finalize`；每进程生命周期恰好一条 `finalize` 且为最后一条；文件 sink 与 HTTP sink 序列逐事件一致（10 条）。
  - 压缩场景：epoch 0→1、压缩当轮抑制后恢复，状态流 `pause→running→pause→running→finalize`。
- 判据核对：DS-06（每 `(session_id, source)` 至多一条 `finalize` 且最后一条）与 DS-12（静态条目带 `range.end` + `unit=message`）语义吻合；外部框架复跑（`cd framework && bash run.sh --harness dsh --fresh`）在 Windows/WSL 环境执行，**待验收**。

## 交付说明与剩余限制

- 改动：`src/{status,index,adapter,hint,config}.ts`、`types/dsh.d.ts`、`test/{status,apply,adapter,hint}.test.mjs`、`e2e/{run.sh,stub-server.mjs,capture-check.mjs,e2e.patch.yml,e2e-compaction.patch.yml}`、`README.md` / `README.zh.md`、设计文档与本文；`lib/` 产物随构建同步。
- 遗留（设计文档 §3）：`derivation.join` 声明值与 background-only 执行语义的可能不一致、inbox 通知轮开局的 `user_waiting` 归因——均需协议层裁决，不在本期。
- 静态 `cacheControl` 显式给部分 `range`（如只有 `start`）时逐字尊重，判据可能仍报缺 `end`——属用户显式配置责任，配置校验不拦截（与设计裁决一致）。
