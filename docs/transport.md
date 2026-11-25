# Chat 与 Messages 传输合同

适用：本包 0.4.x / DSH 0.2.2-rc.1。数据面与生命周期控制的 hint 一律走 `X-Agent-Hint` 请求头；请求体永不携带 hint 字段。

## 端点

Chat 的数据与控制共用 URL 规范化：根地址补 `/v1/chat/completions`，已有 `/v1` 不重复。Messages 的数据面使用官方适配器（`/v1/messages`），生命周期控制仍走 Chat 入口（可通过 `agentHint.sessionControl.endpoint` 显式覆盖）。

## Hint 走线

- 编码：AgentHint 对象 → UTF-8 JSON → base64url（无 padding）→ `X-Agent-Hint` 头值。
- 普通请求携带 `session`（含 `state: start | append`）、`priority_control`、`cache_control`。
- 生命周期动词（`pause` / `resume` / `stop` / `compact`）走独立的 manage 请求：占位 body（`{ model, messages: [], stream: false }`）+ 同一请求头上的 `session.state` 与 `context_management{manage_request: true, edits}`。
- 辅助请求（任意非空 `purpose`，如压缩摘要、会话标题）不携带任何 hint；编译期与运行期都以 `purpose` 是否存在判定。
- `state` 没有 "running" 值：普通请求用 `append` 表示会话继续，`start` 只在新会话首条普通请求出现一次。

## 两条传输

### Chat

自实现 Chat Completions 适配器，逐请求把 hint 写入 `x-agent-hint` 头。保留 system/developer/user/assistant/tool 角色；tool 结果发送 `tool_call_id`，assistant 调用发送相应 id/name/arguments，reasoning 历史映射为 `reasoning_content`。工具声明每次完整发送；历史 tool-addition/removal 标记按不支持原生工具更新的合同移除。声明文本输入能力；未由宿主转换的原生图片/文件与未知内容明确报 `UNSUPPORTED_CONTENT`，不会静默变成空输入。

### Messages

沿用官方 `DeepSeekAdapter`（附件能力由官方实现）。官方适配器没有 per-request header 扩展点，唯一可用的接缝是 `resolveAuth(connection)` 返回的 headers 会按请求展开；因此本插件用 AsyncLocalStorage 把当前请求的 hint 绑定到异步链，在 `resolveAuth` 中写入 `x-agent-hint`。每次 generator 恢复都重新进入该作用域，并发请求不会互相看到对方的 hint。宿主日后提供正式的 header 钩子时应替换该接缝。

Messages 的 `prepareExtensions` 不再贡献任何字段，只保留 `accept()` 用于"端点 2xx 后才推进 start/append 记账"。

## 流

支持 LF/CRLF/CR、跨字节与多行 data。`[DONE]` 结束流并取消剩余 body。工具 id/name/arguments 允许分片；真实 tool id 可用后立即交付暂态 `tool-call-delta`，id 未到达时暂存片段、不伪造。暂态增量不授权执行：所有并行调用的身份与完整 JSON 在正常终态前统一校验，失败不完成任何工具块，无参数调用保留 `{}`。正常终态前，每个已打开的 text/reasoning/tool-call 块发送携带累计内容的 `block-end`，再输出 usage/finish。`length` 终态关闭原始截断块而不补造身份或 JSON。缺失 finish、非法 JSON、未结束事件、流内 error 都不能报告正常 stop。

usage 区分未缓存输入与缓存读入：`prompt_tokens` 与 `completion_tokens` 必须同时存在且为非负安全整数才发布完整 TokenUsage；缺失或 null 不补零、不覆盖此前完整样本；显式零是合法值；cached 不能大于 prompt，reasoning 不能大于 completion，total 若提供必须等于 prompt+completion。

HTTP 鉴权、限流、额度、服务器、超窗与请求错误按宿主错误码分类，保留 status、request id 与 Retry-After；重定向一律拒绝。

## 验收边界

本地 stock AgentLoop/Tools、真实 BasicCompaction 与本地 mock HTTP 的集成通过，不等于真实模型、真实引擎 KV 动作或性能合格。参见[可靠性合同](reliability.md)。仓库内 e2e 与单测覆盖 wire 形状，不随包发布。
