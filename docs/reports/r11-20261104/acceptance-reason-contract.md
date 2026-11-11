# 连续变更：`acceptanceReason` 契约结论（#62）

观察 tip：与 `dev` 对齐的零付费调查。付费旁路证据：round-9（`requirements[].acceptanceReason` 未授权）、round-10（缺 plan 根原因与 cap 并列）。

## 宿主权威（现状）

| 位置 | 行为 |
| --- | --- |
| [`plan-input.ts`](../../../src/evolution/plan-input.ts) `planInputSchema` | `acceptanceReason` **仅**在 propose_plan 参数顶层；`requirements[]` items `additionalProperties: false` |
| [`evolution.ts`](../../../src/evolution/evolution.ts) | 改变已接受需求 hash 时读 `call.args.acceptanceReason`；缺失 →「既有需求 … 须说明验收修订原因」；多项变更**共用**这一条 |
| [`planning.ts`](../../../src/server/planning.ts) 工具描述 / 规划指令 | 已强化：须写 plan 根，**禁止**写在 `requirements[]` |

## 结论（默认落地 A）

**保持且强化「仅 plan 根」**：不引入 per-requirement reason。

理由：

1. 与 schema 一致，避免双通道；
2. Evolution 已按一次 call 共用一个原因记账 `acceptanceChanges`；
3. round-9 失败模式正是模型误放层级，应用描述/schema 纠错即可，不必扩协议。

**不实施方案 B**（per-requirement 扩展），除非后续零付费证据证明：仅 plan 根 + 描述强化后模型仍系统性无法提交合法修订原因。

## 零付费夹具

- [`tests/app/acceptance-reason-contract.test.ts`](../../../tests/app/acceptance-reason-contract.test.ts)：真实 `planInputSchema` 负/正例 + 修订 blocker
- [`tests/app/round10-review-cap-replay.test.ts`](../../../tests/app/round10-review-cap-replay.test.ts)：call-565 **不注入** reason → 修订原因诊断

## 非目标

Todo 产品功能、抬 30、恢复 revises→新增、付费六步。
