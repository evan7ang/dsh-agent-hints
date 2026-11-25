# Hint trace

默认开启独立的、按会话查询的适配器 trace。记录**同时**落到两处：

1. **DSH 会话日志**（`session.v4.jsonl`，与 `turn/start`、消息等会话事件放在同一个文件里），使用 DSH 0.2.2-rc.1 的 `appendPluginRecord` 通道，一次 attempt 只写一条终态记录；
2. **服务端标准输出**，带 `agent-hint/trace` 前缀的 JSON 日志，可用 `docker logs` 或服务日志采集器读取；每条记录（含 `prepared`/`dispatch` 中间态）都会打印。

## 为什么可以写入会话日志

DSH 0.2.2-rc.1 提供官方实验通道 `appendPluginRecord(session, type, data)`：

- 记录是标记 `ignorable: true` 的事件，不认识的 reader 会保留并跳过它，不会拒绝重建会话；
- 记录不进入模型可见 surface（没有 `surfaceOp`/`sourceEventSeqs`，`session.surface.nodes` 与 `deriveMessages()` 都不受影响）；
- fork / resume 会随日志携带这些记录；
- 本插件只写不读：需要证据时直接从 `session.v4.jsonl` 取记录。

记录类型名带本包前缀（`plugin:dsh-agent-hints/trace`），不会与其他插件撞名。`PluginRecordMap` 是声明合并点，未在此登记的 key 会被 `appendPluginRecord` 的类型直接拒绝。

### 已知取舍：使用了上游限定范围的 API

`appendPluginRecord` 的文档写明「Only production source under `packages/experimental/` may call this」。这是 DSH 仓库对自己的发布流程做的政策约定，不是运行时检查：本插件调用时不会被拒绝、不会降级。升级宿主版本时必须重新确认三件事：该函数仍然存在；`PluginRecordMap` 声明合并点与记录名语法（`plugin:` + 小写斜杠分段）未被改动；不认识的 ignorable 记录仍然「保留并跳过」而不是拒绝加载会话。任一条件不成立时应把 `agentHint.trace.writeToSession` 设为 `false`，回退到「只写 stdout」。

## 配置

在 patch 配置中设置，重启后生效：

```yaml
- id: agent-hints
  config:
    agentHint:
      trace:
        enabled: true
        maxRecords: 2000
        writeToSession: true   # 默认 true；false 时只写 stdout 与进程内窗口
```

- `enabled: false` 同时关闭服务端 trace、内存窗口与会话日志写入，不关闭 Hint 本身。
- `writeToSession: false` 只关闭会话日志写入，stdout 与进程内窗口保持原样。
- `maxRecords` 范围 1–10000，是整个插件实例内存窗口的记录总数上限，所有会话共享；窗口超限淘汰最旧记录。
- 会话日志写入复用同一个 `maxRecords` 作为每个会话的写入预算，达到上限后该会话后续记录只写 stdout（首次跳过记一条 warn）。

## 记录内容与写入时机

每条记录包含 `requestId`、会话 ID、模型、数据/控制平面、协议、阶段、时间和白名单 Hint 字段：`session_id`、`state`、`call_index`、`epoch`（可选 `parent_session_id`）、`context_management`（只保留 `manage_request` 与 edit 类型）、`priority_control`（level/reason）、`cache_control`（ttl_s/msg_offset）。`requestId` 只用于插件内部关联，不自动透传到引擎。

**会话日志只收终态**：每次 attempt 仅在 `phase: 'result'` 时写入一条；`prepared`/`dispatch` 中间态只留在进程内与 stdout。

- Chat：`prepared` 是请求体准备完成；`dispatch/dispatching` 是即将调用 `fetch`，不证明引擎收到。普通请求的 `accepted` 表示收到 2xx 响应头；控制请求还要求响应体读取结束；`httpStatus` 与 `durationMs` 记录该边界。
- 控制请求：记录 `rejected`、`unknown`、`cancelled` 或 `not-dispatched`；缓存修改请求的暂时性 HTTP 错误仍为 `unknown`。`dispatched: false` 区分未发出与发出后取消。
- Messages：官方扩展接口只提供准备与 2xx 后接受回调；header 由数据适配器写入，trace 只覆盖能确认的阶段，不虚构 HTTP 状态或失败原因。

记录不包含 API Key、请求头、完整 URL、对话、工具参数、响应正文或原始错误。标识字符串最多保留 512 字符。诊断输出不改变 Hint 协议、重试策略或生命周期结果。

## 写入失败与旧宿主的降级

写入会话日志是纯诊断动作，任何失败都不影响推理：

- 没有 `sessions` 服务、该会话不在本进程的 Session store 中、或宿主没有导出 `appendPluginRecord` 时，自动跳过会话日志写入；
- `appendPluginRecord` 抛错时捕获并降级为「只写 stdout」，同一会话只 warn 一次；
- 达到 `maxRecords` 预算时跳过并 warn 一次。
