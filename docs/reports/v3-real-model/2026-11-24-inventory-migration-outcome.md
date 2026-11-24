# V3 Inventory Migration 真机验收 Outcome（2026-11-24）

## 结论

**通过（2/2）。** `inventory-migration` 两个步骤全部到达 `preview_ready` 并应用组合，每步均通过四道验证门禁，无协议错误、无预算耗尽、无 Gate 警告。连同已通过的 `todo-six-step`（6/6），V3 真机受控验收已全部达成。

## Run F — `2026-11-24T04-06-29-657Z`（本轮）

| 项 | 值 |
| --- | --- |
| 外层护栏 | `--max-calls=56 --max-cost-cny=32.0` |
| per-run Evolution | `callLimit=24` / `activeMsLimit=20min` |
| 总调用 | 22 |
| 总 tokens | prompt 1,455,811 / completion 141,821 |
| 估算费用 | ≈ ¥8.09 |
| 退出码 | 0（`assertRealModelScenarioPassed` 全步通过） |

| Step | 预期变更 | 实际 affectedPlugins | calls | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 新增 `inventory-expiry` 效期预警插件 | `inventory-expiry:added` | 10 | `preview_ready` → applied |
| 2 | 新增 `inventory-approval` 出库审批插件（>50 拦截，卸载后 `inventory-core` 独立正常出库） | `inventory-approval:added` | 12 | `preview_ready` → applied |

## 与 Run E 的对比（修复效果）

Run E 中 Step 1 因上下文缺失 Host SDK 类型契约，模型在客户端反复探测 `ctx.slot` 并耗尽 24/24 calls。
在提交 `0dff8a4` 将标准 `.d.ts` `hostSdkContracts` 注入初始上下文后，本轮 Step 1 仅用 **10 calls** 即一次通过，Step 2 仅用 **12 calls** 通过，总费用仅 **¥8.09**。

## 累计真机费用（全序列）

| 轮次 | 场景 | calls | 估算费用 | 结果 |
| --- | --- | --- | --- | --- |
| Run A–C | `todo-six-step` | 51 | ≈ ¥19.56 | 最高 3/6 |
| Run D | `todo-six-step` | 41 | ≈ ¥10.58 | **6/6 通过** |
| Run E | `inventory-migration` | 24 | ≈ ¥9.22 | 0/2（Step 1 耗尽） |
| Run F（本轮） | `inventory-migration` | 22 | ≈ ¥8.09 | **2/2 通过** |
| **合计** | — | **138** | **≈ ¥47.45** | **全场景通过** |

## 产物归档

- 原始调用与截图：[docs/reports/v3-real-model/2026-11-24T04-06-29-657Z/](2026-11-24T04-06-29-657Z/)
- `summary.json`：两步 status / changeBrief / budget / events 全量记录
- `inventory-migration/calls.jsonl`：22 次请求-响应原文
- 最终截图：[step-2.png](2026-11-24T04-06-29-657Z/inventory-migration/step-2.png)
