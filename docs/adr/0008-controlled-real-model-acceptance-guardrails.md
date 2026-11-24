---
status: accepted
date: 2026-11-24
---

# 受控真机验收的 STOP_SERIES 与 fail-closed 费用护栏

## 背景

V3 自迭代架构的日常开发、CI 与回归测试全部依赖确定性零付费验证（`pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e`）。但在里程碑验收时，仍需运行真实 LLM（DeepSeek）驱动的端到端验收（`todo-six-step` 与 `inventory-migration`），此类运行存在真实 API 费用风险。

## 决策

1. **默认关闭、fail-closed 入口**：`pnpm accept:v3:real-model`（`scripts/accept-v3-real-model.ts`）必须同时满足环境变量 `V3_REAL_MODEL_AUTHORIZED=1`、命令行显式标志 `--authorize-paid-run` 以及有效 `DEEPSEEK_API_KEY` 方可执行，缺一即零调用直接退出。
2. **STOP_SERIES 纪律**：任何自动流程或 Agent 严禁在未经用户单次显式授权的情况下触发付费真机调用；每轮失败或完成后必须停止并汇报，不得自动续跑下一轮。
3. **双层预算硬顶**：外层由 `--max-calls` 与 `--max-cost-cny` 硬性封顶（超限立即中止并记账），内层单步 `EvolutionLoop` 受 `REAL_MODEL_EVOLUTION_BUDGET`（默认 `callLimit: 24`、`activeMsLimit: 20 min`）约束。
4. **归档治理**：Git 仓库仅保留精简的 `summary.json`、`*-outcome.md` 与关键最终截图；大体积原始调用日志（`calls.jsonl`、`events.jsonl`、`*.db-wal`）不纳入 Git 跟踪。
