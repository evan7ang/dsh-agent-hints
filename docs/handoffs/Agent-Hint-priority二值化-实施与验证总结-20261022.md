# Agent Hint priority 二值化：实施方案与验证总结

| | |
|---|---|
| 日期 | 2026-10-22 |
| 状态 | **三仓实施完成，真实环境 e2e 验证通过（17/17 断言）** |
| 决议依据 | 领导评审反馈：level 四档简化为二值（用户介入 = 高，其余含压缩/维护 = 普通）；组内补充：数值保留 {1,3} 不重编号（Motor 阈值与投影零改动） |
| 关联文档 | `C:\AscendAgent\PRIORITY-ASSIGNMENT.md`（v2 总方案）、Motor `docs/zh/design/20261022-01-agent-hint-priority-two-level.md` |
| 分支 | Motor: `feat/agent-hint-motor-dev` ｜ 插件: `feat/two-level-priority` ｜ Dify e2e: `feat/two-level-priority-e2e` |

---

## 1. 语义定义（写进合同的一句话）

`priority.level` 收窄为二值域 **{1, 3}**：

- **3 = 用户介入的请求**（开局请求、人工审批/暂停恢复窗口）——唯一享受准入豁免（穿透限流预留 + 软负载门槛豁免）的值
- **1 = 其余一切**（自驱续接、压缩维护、批量评测）
- **数值无档位含义**：3 是推理侧准入阈值（`priority_admission_level=3`）的合同锚定常数，唯一语义是比较结果；语义丰富度由 `reason` 承担（user_waiting / critical_path / background，纯审计）
- v1 遗留值 `{2, 4}` 就近折叠（2→1、4→3），越界值按准入线折叠（≥3→3，否则→1）——**任何请求的准入结果与折叠前完全一致**

## 2. 三仓改动清单

### 2.1 Motor（消费执行点，`feat/agent-hint-motor-dev` @ `2e08fea`）

- `agent_hint_wire.py`：`normalize_priority_level()` + 两个注入点（`_merge_priority` 调度门路径、`extract_priority_from_hint_headers` 限流路径）
- `agent_hint.py`：`_parse_priority_control` 注入（body legacy 路径）
- **strict_priority / 阈值配置 / reason 均未动**；设计文档 + 验证文档随仓（`docs/zh/design/20261022-01-*-two-level{,-verification}.md`）

### 2.2 agent-hints 插件（权威发射方，`feat/two-level-priority` @ `8505587`，v0.1.5）

- `pipeline.py`：出口折叠（四层合并后、序列化前）+ **D1 出厂默认改为 `3/user_waiting`**（交互姿态；批量池经 T2 凭据覆盖为 `1/background`）
- `SCHEMA.md` / `README.md`：二值条款 + 数据源说明
- `manifest.yaml` 0.1.4 → 0.1.5

### 2.3 AscendAgent-Dify（e2e 适配，`feat/two-level-priority-e2e` @ `8fdee0b`）

- `scripts/hint-e2e-test.py`：断言适配（`priority==0` → 折叠后 `1`；nvext `100` → `99`）

## 3. 验证记录

### 3.1 单测与回归

| 套件 | 结果 |
|---|---|
| Motor `tests/coordinator/domain/` | **152/152 通过**（含 7 值折叠表、三路径端到端） |
| Motor `tests/coordinator/middleware/` | 与未改动基线 stash 对照**逐项一致**（20/12/20，失败为 WSL 环境缺依赖，非回归；待 Linux 容器复验） |
| 插件 `tests/` | **36/36 通过**（含 nvext {99,97} 投影、reason 保留） |

### 3.2 跨仓冒烟（插件发射 → Motor 消费，6 场景）

| 场景 | 发射 level | reason | nvext | Motor 判定 |
|---|---|---|---|---|
| 默认零配置（交互姿态） | 3 | user_waiting | 97 | 豁免准入 |
| 批量池凭据 hints_json | 1 | background | 99 | 普通排队 |
| 节点参数旧值 7（越界） | 3 | user_waiting | 97 | 豁免准入 |
| v1 遗留 level=2（Pi 旧版） | 1 | user_waiting | 99 | 普通排队 |
| hint service 下发 4 | 3 | user_waiting | 97 | 豁免准入 |
| 旧节点参数 90（v1 习惯） | 3 | user_waiting | 97 | 豁免准入 |

关键性质：越界与遗留值折叠后**准入判定与折叠前一致**（行为保持）；两仓折叠规则同构。

### 3.3 真实环境 e2e（Dify 1.17.1 全栈，2026-10-22）

环境：WSL Ubuntu 22.04 + Docker Compose 全栈（`docker-*` 项目，localhost:80），插件 v0.1.5 实际打包安装，mock 推理端点 + hint service 挂 compose 网络（`hint-mock` 别名），keyless 流程。

```
[install]  agent-hints 0.1.4 卸除 → 0.1.5 安装 ✓
[import]   fixture app 导入发布 ✓（2 个 LLM 节点绑定）
[register] 编译期 hints upsert ×2 ✓
[run]      workflow succeeded ✓（mock 记录 4 个请求：LLM 请求 + agent_status 上报）
[verify]   17 项断言全部 PASS ✓（[cleanup] app 删除 204）
```

逐项断言（关键项加粗）：

```
agent_hint_header ✓          session_id==user_channel ✓
agent_type==service_enriched ✓  call_index==service_enriched ✓
priority_folded==domain ✓（节点参数 0 → header level 1）
prediction_osl==node_param ✓   next_action==service_enriched ✓
cache_pin_first_message ✓      nvext_present ✓
nvext_prefix_id==content_hash ✓
nvext_priority_inverted ✓（nvext priority == 99）
nvext_osl_iat ✓                nvext_latency_sensitivity ✓
pool_header ✓ / auth ✓ / hint_not_leaked ✓ / status_running+finalize ✓
```

### 3.4 优先级字段的效果证据（Motor 准入实验，WP-E）

机制链：插件发射 `priority.level` → Motor 准入层（限流预留穿透 + 软负载门槛豁免）→ 过载场景存活率。实验环境：2×Qwen3-8B 独立栈，令牌桶制造过载，三臂对照（出处：Motor《Agent Hint WP-E 过载准入实验数据-20261015》、设计文档 `20261015-01` §4）：

| 场景 | normal（level<3） | 高优（level≥3） | strict（可信） | strict（伪造） |
|---|---|---|---|---|
| X0 基线（预留关闭） | 23.1% | 23.3% | — | — |
| X1 预留 0.2 | 64.6% | **100%（0×429）** | — | — |
| X2S 预留枯竭（refill 4/s） | **6.7%** | **89.7%** | **100%（0×429）** | 5.2%（入口剥离生效） |

读法：

1. **X0 证明零风险**：开关关闭时高低优先级完全无差异——本方案落地不改变任何既有行为；
2. **X1/X2S 证明真实效果**：过载下用户介入流量的存活率从 6.7% 提升到 89.7%~100%，这就是二值化要保障的核心收益；
3. **伪造对照证明安全边界**：自封高优的请求被信任门剥离（5.2%≈普通水平），插队权只在控制面手里；
4. **二值化的贡献**：把上述保障以最低采用成本覆盖五家 harness（一个 fold 函数 + 一个默认值），语义错误空间最小。

## 4. 发布与合入顺序

1. **Motor MR**：`feat/agent-hint-motor-dev` → `Ascend/MindIE-Motor`（归一独立成立，可先合）
2. **插件发版**：`feat/two-level-priority` → main PR + GitHub Release（0.1.5 difypkg asset）；Dify 侧安装升级
3. **e2e 分支**：随插件发版合入 `tree-zby/AscendAgent-Dify` master

## 5. 各 harness 对齐方案（实施由各 harness 侧执行）

Dify 侧参考实现已验证可行（§2.2 / §3.3），各 harness 按同一规则实施：

**统一规则**（与参考实现同构）：在插件发射出口将 level 折叠进 `{1, 3}`——`{1,3}` 原样、v1 遗留 `{2,4}` 就近（2→1、4→3）、越界按准入线（≥3→3，否则→1）；`reason` 保留原语义；`strict_priority` 一律不产。Motor 侧归一层（§2.1）已兜底，未对齐插件在过渡期行为正确，对齐无阻塞。

| Harness | 实施位置 | 说明 |
|---|---|---|
| **Pi** | `src/hint-build.js` 发布点（`derivePriority` 输出后） | reason 保留状态语义：开局/审批恢复→`user_waiting`/3、自驱续接→`critical_path`/1、压缩维护→`background`/1 |
| **Hermes** | `_settings.py::priority()`（配置读取出口） | 0/空省略语义不变，非零配置值折叠进二值域 |
| **dsh** | `lib/hint.js` relay 处 | 配置值（含 `DEFAULT_PRIORITY` level 3）折叠 |
| **DeepAgents** | 立项时直接按二值域实现 | 无存量迁移成本 |

**验收标准**（各侧自行执行）：

1. 全量测试套件无回归；
2. 真实环境发射模型请求，抓取 `X-Agent-Hint` 解码：`level ∈ {1,3}` 且 reason 成对；
3. 若已对接 Motor：调度日志 `reason=` 字段出现，level 符合二值域。

**实现范本**：agent-hints v0.1.5（`pipeline.py::normalize_priority_level` + 出口折叠）即最简参考——一个纯函数 + 一处出口调用，Motor `agent_hint_wire.py` 归一层为消费侧兜底。

## 6. 边界与遗留

- `strict_priority` 不在本方案内：控制面独占 + token 信任门，二值化不涉及
- 交互 run 中段步骤（含交付步骤）不再豁免准入——已评审确认的取舍（§0 已知取舍），过载数据若显示中段饥饿属 Motor 调度层演进课题
- 批量/评测池统一 `1/background` 写入评测规范的落地（Evaluator/RSI 配合）另行推进
- KV Hint 桥内容留在 `feat/agent-hint-ascend` 分支，独立需求线管理，与本次改动零交叠
