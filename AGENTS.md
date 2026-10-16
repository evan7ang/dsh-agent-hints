# 仓库开发规范

本文件适用于整个仓库。文档的目录分工和维护规则见 [docs/AGENTS.md](docs/AGENTS.md)。

## 仓库目录结构

```text
src/
├── index.ts            # 插件入口：注册 agent-hints 插件，接线会话事件与状态通道生命周期
├── adapter.ts          # deepseek-hint 独立路由的结构化 LlmAdapter 实现：请求序列化、SSE 解析、
│                       #   错误码映射、X-Agent-Hint 头注入
├── config.ts           # normalizeConfig：agent-hints 行配置的校验与归一化
├── hint.ts             # AgentHint 计算：会话身份、call_index/epoch、优先级与缓存控制词汇
├── status.ts           # 带外状态通道：会话日志派生事件（tool/running/finalize），
│                       #   JSONL statusSink 发射
test/                   # node --test 单元测试（对 lib/ 构建产物运行）
├── adapter.test.mjs    # 适配器 wire 行为
├── apply.test.mjs      # 配置归一化与插件接线
├── hint.test.mjs       # hint 计算
├── status.test.mjs     # 状态通道
e2e/                    # 免 key 线上验证（不修改 harness 源码）
├── run.sh              # e2e 入口：解析 dsh 运行时（DSH_BIN > PATH > deepseek-harness checkout），
│                       #   在 scratch profile 安装本包并跑一轮工具往返
├── stub-server.mjs     # SSE 抓包 stub（chat-completions 模拟端点）
├── capture-check.mjs   # 抓包断言：header 携带、call_index 连续、body 零 hint 泄漏、状态事件
├── fixture-tool.mjs    # e2e 探针工具
└── e2e.patch.yml       # e2e wire overlay（挂载探针工具 + 覆盖 agent-hints 行配置）
types/
└── dsh.d.ts            # DSH 运行时服务的最小结构化类型桩；仅满足本地构建，
│                       #   不依赖 harness checkout
lib/                    # tsc 构建产物，提交入库（测试与 e2e 对产物运行，不直接修改）
docs/                   # 设计与任务文档，分工见 docs/AGENTS.md
```

| 路径 | 用途 |
| --- | --- |
| `README.md` / `README.zh.md` | 项目介绍、协议形状、配置与验证入口 |
| `docs/design.md` / `docs/design.zh.md` | v1 已发布设计（README 链接指向此位置，不迁移） |
| `cordis.patch.yml` | bundle 挂载 patch（mount id `agent-hints`） |
| `package.json` / `package-lock.json` | 包信息、构建与测试命令、依赖锁定 |
| `tsconfig.json` | TypeScript 严格类型检查 |
| `LICENSE` | 木兰宽松许可证第 2 版（MulanPSL-2.0） |
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
npm run typecheck    # tsc --noEmit
npm run build        # src/ → lib/（产物提交入库，构建后需一并提交）
npm test             # node --test test/
bash e2e/run.sh      # 免 key wire e2e：需环境上有 dsh（DSH_BIN / PATH / DSH_CHECKOUT）
```

### TypeScript 与插件约束

- ESM + `NodeNext`；本地相对导入写 `.js` 扩展名，Node 内置模块用 `node:` 前缀，纯类型用 `import type` / `export type`。
- 保持 `strict` 等编译选项，不通过关闭规则规避类型问题；外部输入先用 `unknown` 接收并收窄，避免无依据的 `any` 和非空断言。
- 两个空格缩进、双引号、分号；文件 UTF-8、LF、以换行结束。文件名 `kebab-case`，变量函数 `camelCase`，类型 `PascalCase`。
- **自包含约束**：不新增对 harness 运行时包的 import（`@deepseek-ai/cordis` 仅类型导入，构建期擦除）；运行时服务通过 `types/dsh.d.ts` 的结构化鸭子类型触碰，扩展类型桩时保持与 `src/` 实际使用同宽。
- **wire 约束**：请求 body 不携带任何 hint 字段；`X-Agent-Hint` 头仅主线请求发射，辅助请求（compaction / session-title）不带；hint 计算与传输编码的改动须同步核对 e2e 抓包断言。
- 配置校验与激活分离：`normalizeConfig` 校验并给出明确错误，未配置字段按既有回退语义处理；错误在组合期暴露，不在请求中途静默降级。
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
[feature] statusSink 支持有界重试
[bug] 修复辅助请求误带 X-Agent-Hint 头
[docs] 更新协议配置说明
```
