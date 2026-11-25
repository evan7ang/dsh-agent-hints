# 可靠性合同

适用：本包 0.4.x / DSH 0.2.2-rc.1。

## 控制结果

`SessionControlClient` 返回 accepted / failed / unknown / cancelled（附是否派发）。accepted 只表示 HTTP 2xx 且响应体正常读取，不是 KV 动作完成。超时、网络错误、响应体中断都是未知结果；mutation 的 HTTP 408/429/5xx 也不证明未执行。

只有 resume 的明确瞬态 HTTP 拒绝允许自动重试；pause / compact / stop 永不自动重试。一次控制操作固定端点与凭据快照，连接解析同样有超时与取消。

## 会话顺序

- 普通请求在进入适配器前取得整条流的 lease，覆盖 `prepareCall` 与 `stream` 两种入口，直到模型流完成、错误、取消或迭代器退出才释放。
- 变更操作（pause / compact / stop）等待该会话已开始的流结束；新普通请求等待最新控制队列尾。
- 默认屏障 2 秒，单次控制超时 5 秒。预取可以在屏障超时后继续；缓存变更仍在排队/执行或结果未知时，新的普通请求抛 `ControlBarrierError`。未知变更在当前 bridge 内隔离，会话销毁重开也不能自动清除。
- 明确失败的 resume 经过 1 秒冷却可再触发。后台 purpose 请求不推进普通状态。实际选定的 model 传给控制请求。

## 生命周期触发

| state | 触发 |
| --- | --- |
| `start` | 全新会话（不带历史）的首条被接受的普通请求 |
| `append` | 其余普通请求 |
| `pause` | 另一会话的普通请求被接受、且本会话 agent 空闲、在途流结束 |
| `resume` | 带历史/已 pause 会话的下一条普通请求前；或浏览器观察到草稿由空变非空 |
| `stop` | 会话销毁；或成功归档 |
| `compact` | `compaction/end` 且无 error（携带被驱逐的旧 epoch） |

`start`/`append` 随普通请求发出；其余动词走独立 manage 请求（占位 body，hint 在 header）。

## 浏览器 composing

浏览器每个连接世代发一次只读 `agentHintSignals/available` 探测（`{args:{}}`），成功后挂载观察器，断连/卸载撤销。观察器在当前 composer 内监听 `beforeinput`、`paste`、`input`，经认证 RPC 发送 `composing`（`{args:{request:{sessionId}}}`）。只发送 sessionId，不传草稿文本，不创建或启动 Agent；连续编辑静默，清空后重新允许通知。

DOM 事件定位依赖目标 DSH 的 `[data-slot="conversation.composer.bar"]`、`[data-composer-input="true"]` 与 contenteditable 标记；缺标记、探测失败或监听器挂载前发生编辑时，由普通请求前的 resume 兜底，不承诺发送前提前量。

## 卸载与恢复

插件 lifetime signal 取消解析、退避、fetch 和排队发送，卸载后不再派发新的控制；已经到达后端的操作不能撤回。请求取消或客户端超时不是后端停止证明。进程退出时发出的 `stop` 可能与退出竞争，可能只完成派发而未被后端接收。

遇到 `ControlBarrierError` 先核对协调器的会话/动作与结果；需要继续工作时使用新会话 ID。隔离状态不落盘，不跨插件重载/进程重启或多个 DSH 实例共享。

## 后端仍需负责

- HTTP 接受后的异步 KV 完成确认。
- 跨实例、重启与迁移后的版本隔离/fencing。
- Hint 字段完整转发、会话块登记、实际 offload / prefetch / evict 与消费。
- 消费端对归一化 header 的支持：`session.state`、`context_management`、`priority_control` 的解析，以及 manage 请求（空 `messages`）的放行。**本包发布时消费端可能尚未跟进；未跟进时生命周期动词与优先级准入会静默不生效。**

本插件修复客户端顺序与取消，不补造后端事务协议。更换 backend 要协调窗口、排空并新建会话。

## 本地验收

类型检查、构建、单测（含 stock Loader / AgentLoop / Tools / BasicCompaction 集成）、打包检查与 e2e 属于本地验收；真实引擎 KV 动作、真实模型质量与性能不在本地结论内。
