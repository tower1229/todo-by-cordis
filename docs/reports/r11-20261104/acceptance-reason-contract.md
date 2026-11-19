# 连续变更：`acceptanceReason` 契约结论（#62）

观察 tip：与 `dev` 对齐的零付费调查。付费旁路证据：round-9（`requirements[].acceptanceReason` 未授权）、round-10 / `461699a` / `93b88a6`（缺 plan 根原因与宿主投影 churn 假阳性并列）。

## 宿主权威（现状）

| 位置 | 行为 |
| --- | --- |
| [`plan-input.ts`](../../../src/evolution/plan-input.ts) `planInputSchema` | `acceptanceReason` **仅**在 propose_plan 参数顶层；`requirements[]` items `additionalProperties: false` |
| [`acceptance-surface.ts`](../../../src/evolution/acceptance-surface.ts) | 修订门禁比较 **acceptanceSurface**（业务骨架），不是全对象 `hash(Requirement)` |
| [`evolution.ts`](../../../src/evolution/evolution.ts) | 既有需求 `requirementAcceptanceChanged` 时读 plan 根 `acceptanceReason`；缺失 →「既有需求 … 须说明验收修订原因」；多项变更**共用**这一条 |
| [`planning.ts`](../../../src/server/planning.ts) 工具描述 / 规划指令 | 已强化：须写 plan 根，**禁止**写在 `requirements[]` |

## 比较面（acceptanceSurface）

纳入：`id` / `description` / `sourceRevision` / `sourceQuote` / `type`，以及义务业务骨架。

**去掉（宿主投影，不算业务修订）**：

- 整表 `checks`
- `workflow-input` 义务
- `field` 且 `derivation` 或 `initialOrigin=="host"`
- `assertion.availability`；steps / scenarios 里宿主注入的 `action.input`
- `backend` 嵌套 checks；`history` 准备块

因此：只加复盘时 `compileReferences` 晚继承改写 tags/counter 的 checks / workflow-input / complete input **不再**假阳性要求 `acceptanceReason`。故意改 quote / 非宿主 field 义务仍触发。

## 结论（默认落地 A）

**保持且强化「仅 plan 根」**：不引入 per-requirement reason。

理由：

1. 与 schema 一致，避免双通道；
2. Evolution 已按一次 call 共用一个原因记账 `acceptanceChanges`；
3. round-9 失败模式正是模型误放层级，应用描述/schema 纠错即可，不必扩协议；
4. `93b88a6` 证明：假阳性来自全对象 hash，应用表面比较收口，而不是削弱真修订门禁。

**不实施方案 B**（per-requirement 扩展），除非后续零付费证据证明：仅 plan 根 + 表面门禁后模型仍系统性无法提交合法修订原因。

## 零付费夹具

- [`tests/app/acceptance-reason-contract.test.ts`](../../../tests/app/acceptance-reason-contract.test.ts)：schema 负/正例 + 真修订 blocker + 宿主 churn 无 blocker
- [`tests/app/phase3-review-461699a-replay.test.ts`](../../../tests/app/phase3-review-461699a-replay.test.ts)：call-629 只加复盘 → 表面门禁无修订 blocker
- [`tests/app/round10-review-cap-replay.test.ts`](../../../tests/app/round10-review-cap-replay.test.ts)：call-565 同上

## 非目标

Todo 产品功能、抬 30、恢复 revises→新增、付费六步、削弱真修订门禁、review 信封协议。
