# 仓库开发规范

本文件适用于整个仓库。文档的目录分工和维护规则见 [docs/AGENTS.md](docs/AGENTS.md)。

## 仓库目录结构

```text
src/
├── index.ts            # 插件入口：注册 agent-hints 路由，接线端点继承、配置、trace 与生命周期
├── hint.ts             # 归一化 AgentHint：四块结构、6 值 state、普通/manage 构造、会话事实推导
├── cache.ts            # 动态 cache_control：TTL 推导、msg_offset、抑制签名
├── config.ts           # schemastery Config；端点、模型目录与凭据引用的解析与继承
├── chat-adapter.ts     # Chat Completions 适配器：请求序列化、SSE 解析、错误码映射、头注入
├── adapter.ts          # Messages 适配器：官方 DeepSeekAdapter 扩展；resolveAuth + ALS 注入头
├── extension.ts        # Messages 的 prepareExtensions：不贡献字段，仅 2xx 后记账
├── lifecycle-bridge.ts # 生命周期触发、数据面租约、变更屏障与隔离
├── control-client.ts   # manage 请求客户端：header 承载、占位 body、结果分类
├── archive-observer.ts # 公开归档方法观察（归档即 stop）
├── composing-service.ts# 宿主侧 composing RPC 服务（浏览器草稿通知）
├── host-events.ts      # 宿主事件声明（session/composing、workspace/session-archived）
├── inherited-connection.ts # 从 llm-deepseek 路由读取生效配置
├── trace.ts / trace-record.ts / session-trace.ts # 有界、无内容的诊断 trace
└── client/             # 浏览器端：composer 打字观察器（React + 槽位）
    ├── index.ts
    └── observer.ts
tests/                  # vitest specs（直测 src）+ node --test tests/trace.test.mjs（对 lib 产物）
├── helpers/            # 测试用 DOM/宿主辅助
e2e/                    # 免 key wire e2e（不修改 harness 源码）
├── run.sh              # e2e 入口：解析 DSH 0.2.2-rc.1（DSH_BIN > 缓存安装），scratch profile 跑两轮
├── mock-upstream.cjs   # chat-completions 抓包 stub（记录 header 与 body）
└── verify-headless.cjs # 抓包断言：四块 header、start/append、manage 请求、body 零 hint
lib/                    # tsc（host/client）与 esbuild 产物，提交入库
docs/                   # 设计与任务文档，分工见 docs/AGENTS.md
```

| 路径 | 用途 |
| --- | --- |
| `README.md` / `README.zh.md` | 项目介绍、wire 契约、配置与验证入口 |
| `docs/design.md` / `docs/design.zh.md` | v1 已发布设计（保留，wire 形状已被新设计取代） |
| `docs/design/` / `docs/tasks/` | 后续设计与任务文档（命名 `YYYYMMDD-NN-slug.md`） |
| `docs/transport.md` / `docs/reliability.md` / `docs/endpoint-inheritance.md` / `docs/trace.md` | 随包发布的合同文档 |
| `cordis.patch.yml` | bundle 挂载 patch（mount id `agent-hints`） |
| `package.json` / `package-lock.json` | 包信息、构建与测试命令、依赖锁定 |
| `tsconfig.json` / `tsconfig.host.json` / `tsconfig.client.json` | TypeScript project references（宿主面 / 浏览器面） |
| `vitest.config.ts` / `scripts/` | 测试配置、client 打包、包内容与安装自检 |
| `LICENSE` / `NOTICE` | 木兰宽松许可证第 2 版；MIT 派生代码归属 |
| `node_modules/` / `.scratch/` | 安装依赖与本地临时材料，不提交 |

## 代码开发规范

### 开发流程

1. **每个开发需求附带设计文档与任务验证文档。** 新增能力、跨模块重构、协议或配置格式变化，设计文档放 `docs/design/`，任务与验证文档（目标、实现路径、验收标准、进展与结果）放 `docs/tasks/`，命名规则见 docs/AGENTS.md。已有设计覆盖时直接引用并说明增量，不重复建档。
2. **任务写清目标、实现路径和验收标准。** 实施时在同一任务文档维护进展、调整和验证结果；不为同一任务重复建立 plan、progress、result 文档。
3. **小 bug 和局部改动可以 ad hoc。** 范围清楚、影响有限的修复和文字调整可直接修改并验证，不强制建文档；发现涉及协议、共享结构或配置契约时升级为设计与任务流程。
4. **修改前确认当前状态。** 阅读相关实现、类型桩和已有测试，保留工作区中其他人的修改；不顺带整理无关文件或扩大改动范围。
5. **按影响范围验证。** 涉及 hint 计算、适配器或配置的改动至少跑 `npm run typecheck && npm run build && npm test`；涉及 wire 行为或插件接线的改动必须再跑 `bash e2e/run.sh`。不为复述实现而增加测试。
6. **交付说明实际结果。** 说明改动、验证命令与结果、剩余限制。未执行的验证明确标注待验收，不记为通过。

常用验证命令：

```bash
npm run typecheck    # tsc -b --force
npm run build        # src/ → lib/types + lib/client.js（产物提交入库，构建后需一并提交）
npm test             # vitest run + node --test tests/trace.test.mjs
npm run check        # typecheck + test + 包内容/锁一致性检查
bash e2e/run.sh      # 免 key wire e2e：需 DSH 0.2.2-rc.1（DSH_BIN 或缓存安装）
```

### TypeScript 与插件约束

- ESM；`tsconfig.base` 使用 `module: esnext` + `moduleResolution: bundler`；本地相对导入写 `.js` 扩展名，Node 内置模块用 `node:` 前缀，纯类型用 `import type` / `export type`。
- 保持 `strict` 等编译选项，不通过关闭规则规避类型问题；外部输入先用 `unknown` 接收并收窄，避免无依据的 `any` 和非空断言。
- 两个空格缩进、双引号、分号；文件 UTF-8、LF、以换行结束。文件名 `kebab-case`，变量函数 `camelCase`，类型 `PascalCase`。
- **宿主依赖约束**：按 DSH 插件惯例使用 peerDependencies，版本锁定 DSH 0.2.2-rc.1 / cordis ~4.1.0 / schemastery ~3.19.0；运行时不打包 harness 包。官方包升级时须复核 `resolveAuth` header 展开、`appendPluginRecord`、`effectiveConfig`、Gateway Remote 发现等被依赖的宿主细节。
- **wire 约束**：请求 body 不携带任何 hint 字段；hint 只出现在 `X-Agent-Hint` 头（UTF-8 JSON，base64url）。普通请求发 `session.state ∈ {start, append}`、`priority_control`、`cache_control`；生命周期动词（pause/resume/stop/compact）只走 manage 请求（占位 body），并显式携带 `context_management.edits`。辅助请求（任意非空 purpose）不带 hint。hint 计算、传输编码或 manage 请求的改动须同步核对 e2e 抓包断言。
- 配置校验与激活分离：schemastery `Config` 在组合期校验，显式配置覆盖继承值，未配置字段按回退语义处理；错误在组合期暴露，不在请求中途静默降级。
- 注释解释约束、原因和非显然边界，不重复代码字面含义；不泄露 API key 等认证信息到日志、配置或测试输出。

## Git Commit 规范

提交信息采用以下格式，方括号内只选一个类型：

```text
[feature] 简短中文说明
[bug] 简短中文说明
[docs] 简短中文说明
```

- `feature`：新增或调整功能；重构按实际目的选择 `feature` 或 `bug`。
- `bug`：修复问题。
- `docs`：修改文档。
- message 一行概括主要改动，不展开实施过程或验证细节；不写作者信息，不添加 `Co-authored-by` 等署名。
- 每个提交围绕一个明确目的；构建产物 `lib/` 与 `src/` 改动同批提交，保持一致。
- 不提交 key、真实认证配置、依赖目录、缓存或临时测试输出；交接文档（`docs/handoff-*.md`）仅本地保存，不入库。

示例：

```text
[feature] manage 请求支持有界重试
[bug] 修复辅助请求误带 X-Agent-Hint 头
[docs] 更新协议配置说明
```
