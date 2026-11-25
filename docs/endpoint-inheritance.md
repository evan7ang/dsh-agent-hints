# 有效配置继承

适用：本包 0.4.x / DSH 0.2.2-rc.1。实现：`src/config.ts`、`src/inherited-connection.ts`、`src/index.ts`。

## 实际来源

每次解析读取公开 Loader 条目，要求来源 id 为 `llm-deepseek`、唯一、未禁用、已激活。从其有效 fiber 配置读取 volatile 引用并经官方协议 resolver 处理，包含 schema 默认目录与生成设置。没有 Loader 时兼容 ConfigEditor 原始层，并经官方 schema 校验。非法源配置显式报错；缺失/未激活/重复来源不贡献配置。

不缓存继承结果；全局 volatile 更新与源生命周期变化刷新目录注册。每个 prepared 请求固定自己的设置，不因热更新混用另一代端点和鉴权引用。源端点更换不迁移已有 KV 会话，管理员应排空请求后新建会话。

## 优先级

显式插件参数优先，省略时继承源实际值，再使用协议默认值。显式 localhost 和空模型目录都受尊重。地址没有来源时依次读 `DSH_AGENT_HINT_BASE_URL`、`DEEPSEEK_BASE_URL`，最后使用内置默认地址。

`transport`、provider 与 AgentHint 策略属于本插件，不由源路由决定。Chat 最终模型信息提供真实上下文容量、输出上限、thinking/effort 默认值与重试策略，同时声明文本输入能力。

## 凭据

只继承引用，不把密钥写回配置。最终模型端点与源完整 URL 相同（忽略末尾斜线）、没有显式引用且未禁用 `inheritCredentials` 时才继承。继承引用使用 `x-api-key` 匹配官方 API-key 路由；显式插件引用保留 Bearer。

请求时从 credentials 服务解析引用；该服务不存在时读取启动环境。显式引用缺失报 `MISSING_CREDENTIAL`。源默认 `DEEPSEEK_API_KEY` 可能在无鉴权本地协调器上不存在，所以继承引用缺失时不发送凭据；受保护后端仍可以返回 AUTH 错误。

有凭据引用且控制 origin 不同于模型 origin 时拒绝控制，不转发密钥。数据与控制请求均拒绝重定向。

## 验证

真实 Loader 测试覆盖：源 A→B、默认目录、删除/重加/禁用/恢复、显式覆盖与凭据退出继承。Chat prepared-call 回归覆盖端点/引用同一代快照，stock AgentLoop 集成覆盖继承后的实际 HTTP 字段。
