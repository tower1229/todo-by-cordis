# r11 付费六步系列停止与身份收缩验证

观察：2026-11-06。合入主线：PR #53 → `codex/model-interface-contraction`，PR #52 → `master`（`82e4bff`）。付费确认 tip `bdba58e`。

## 1. 系列停止（已生效，round-10 再确认）

按 `retrospective-rounds1-8.md` §4.4，**round-9 与 round-10 两次付费确认均死在同类 `plan-compilation`**：

| 条件 | 证据 |
| --- | --- |
| 确认轮再次死在 `plan-compilation` | round-9 `97a95fd`：`32>30`；round-10 `bdba58e`：`33>30`（另含既有需求变更缺 `acceptanceReason`） |
| 同类 cap 错误 | round-4 `34>30` → round-7 `33>30` → round-9 `32>30` → **round-10 `33>30`** |
| 完整六步通过 | 仍为 0 |
| 费用/调用 | round-10 后约 **$11.62 / $20**；累计 **565/650**；**不是续跑理由** |

**决定：r11 付费六步系列保持关闭。** 不再开 round-11 或任何新的 `authorize-real-model` / extended-ms 付费六步，直至零付费夹具能用真实停用/启用标签提案形态证明 ≤30（不仅是干净冻结链）。CI 绿、额度未花完、零模型干净链绿，均不构成续跑理由。

## 2. 身份模型收缩（已落地）

相对 round-9 tip `97a95fd` 之后：

| 机制 | 位置 | 作用 |
| --- | --- | --- |
| `browserCaseStem` | `src/shared/acceptance-obligations.ts` | field/history 同字段共用 stem；ui-identity / action-visible 按断言共用，不按 obligation.id 另起家族 |
| 生成侧 host-snapshot supersede | `browser-case-content.ts` + `references.ts` | 当前 UI 快照覆盖旧同配额案例 |
| `PlanStructureBlocked` | `compileReferences` / `parseBrowserCases` | 超限与义务案例未入清单第一次即结构终止 |
| inherit 后超限 / 悬空 | `evolution.ts` | 追加冻结案例后若仍 >30 或悬空 check：`retryable=false`，不再 `propose_plan` |
| 上限 | 保持 **30** | 未抬高；靠规范化键与生成侧覆盖，不靠事后哈希碰运气 |

## 3. 零付费门禁（本机已跑）

Node v24.18.0。命令：

```text
node --import tsx --test --test-concurrency=1 \
  tests/app/round7-disable-tags-replay.test.ts \
  tests/app/round9-disable-tags-replay.test.ts \
  tests/app/round10-review-cap-replay.test.ts \
  tests/app/browser-case-identity.test.ts \
  tests/app/inherited-field-projection.test.ts \
  tests/app/field-reference-rebind.test.ts
```

| 套件 | 结果 |
| --- | --- |
| round7 / round9 / round10 replay + browser-case-identity | pass（含 inherit 超限、缺 `acceptanceReason`、结构终态） |
| inherited-field-projection + field-reference-rebind | 40/40 pass |

覆盖的复盘要求：

- 停用标签 0→4 冻结链 ≤30、无悬空 check
- 同字段不同义务 ID 叠层投影可编译闭合
- round-9 fixture 单需求提案（调用 545 形态）≤30、ui-identity 规范 ID、历史案例保留
- round-10 call-565：补 plan 根 `acceptanceReason` 后 ≤30；**不注入**时须出现「须说明验收修订原因」
- 超限仍为 `PlanStructureBlocked` / 同文案硬停，不抬上限；`planningStructureTerminal(structural)` 为真

## 4. 仍未声称的事项

- 未用真实 DeepSeek 在收缩后 tip 上重跑六步（**有意不开**）。
- round-7/9 outcome 的 `plans: []`，无法逐条重放原 33/32 条 `propose_plan` 草案；夹具用冻结链 + 身份分叉 / round-9 fixture 提案代替。
- 未跑全量应用测试套件与 E2E；未生产部署。
- `6bacd68` / `8b18866` 策略降级债务未在本轮裁决。

## 5. 零模型 0→5（已补）

`tests/app/round7-disable-tags-replay.test.ts` 与 `tests/app/round9-disable-tags-replay.test.ts` 在停用标签之后继续编译 `v1Requests[5]`（重新启用标签）：

- 断言 ≤30、无悬空 check、结构错误不可重试。
- 启用路径为纯 `enabled: true` 启停候选（不得混入 features/cases），与产品契约一致。

本机：`node --import tsx --test` 上述两文件 **4/4 pass**。

## 6. 策略债开票与部分裁决

GitHub Issue [#54](https://github.com/tower1229/todo-by-cordis/issues/54)：不在本系列用付费探针 closure。

| 项 | 状态 |
| --- | --- |
| `8b18866` 多历史最短路径 | **保留**（维护者书面确认；零付费回归见 `historical-preparation*.test.ts`） |
| `6bacd68` revises 变新增 | **撤回**（恢复「既有要求不存在」致命；见 `planning-requirement-revision.test.ts`） |

## 7. 演示域扩张纪律（有效；非 Todo 产品冻结）

按 [`CONTEXT.md`](../../../CONTEXT.md)：项目核心是模型驱动的自迭代架构；Todo 只是验证用的参考业务，**不是**要单独做成产品的交付方向。增加 Todo 功能本身不能替代自迭代有效性、可信性、接口简洁性或迁移能力。

本节原题「业务扩展冻结」易被读成「停做 / 开做 Todo 产品」，故改写为演示域纪律：

- **优先**自迭代宿主不变量（编译/继承/验收门禁、身份与配额、证据链、模型接口收缩等）。
- **允许**改动演示域（Todo 插件/字段/工作流等），当且仅当它是验证某条自迭代能力所必需的最小夹具或场景。
- **不新开**以演示域功能增量本身为交付物、却不服务自迭代验证的实现 Issue。
- **不把**「完整六步真实模型通过」当作目标达成的替代；也不反向用演示域功能冲淡架构债。
- 已在飞的相关 PR/Issue 不因本节自动关闭；排序仍以自迭代收益为准。

r11 期间曾用更硬的「暂缓演示域扩张」挡队列冲散；#54/#56/#57 落地后，纪律保留上述三条，**不再**表述为「Todo 业务开停开关」。

## 8. Round-10 付费确认（已跑，已停止）

| 项 | 值 |
| --- | --- |
| tip | `bdba58e`（身份收缩 + 0→5 零模型已合入 contraction） |
| 证据 | `bounded-probe-bdba58e-outcome.json` / `.runtime/.../bounded-probe-bdba58e-20261106T101210Z` |
| 调用 | 546–565（20 次） |
| 费用护栏 | 约 $11.62 / $20 |
| 进度 | phase-0..2 截图；停在后续规划 |
| 停止 | `浏览器验收案例超出上限：33 条，最多 30 条` + 既有需求变更缺验收修订原因 |
| 系列 | **STOP_SERIES**（见 `round10-bdba58e-finish-report.json`） |

## 9. 下一步（零付费）

收口进度与推进顺序见 [progress-and-next.md](./progress-and-next.md)（`dev` / `master` tip 对齐后的现行清单）。摘要：

1. #54 已裁决并合入；round-10 `33>30` 已由 [#56](https://github.com/tower1229/todo-by-cordis/pull/56) 消除。
2. **不开**下一轮付费，除非维护者另授权单次确认。
3. 下一刀排在自迭代能力本身；演示域改动只作验证夹具。
