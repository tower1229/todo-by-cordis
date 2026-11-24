# V3 Todo 六步真机验收 Outcome（2026-11-23）

## 结论

**未通过（4/6）。** 最高护栏轮次完成 Step 1–3 并应用组合，Step 4（复盘接缝）在 per-run 18 次调用上限处暂停；Step 5–6 未执行。父 Issue #66 保持 open。

## Run C — `2026-11-23T06-56-12-573Z`（本轮）

| 项 | 值 |
| --- | --- |
| 外层护栏 | `--max-calls=72 --max-cost-cny=40.0` |
| per-run Evolution | `callLimit=18` / `activeMsLimit=20min` |
| 总调用 | 36 |
| 估算费用 | ≈ ¥13.21 |
| Step 1 tags | `preview_ready` → applied（7 calls） |
| Step 2 counter | `preview_ready` → applied（6 calls） |
| Step 3 tags lowercase | `preview_ready` → applied（5 calls） |
| Step 4 review | `awaiting_budget`（18/18 calls）；**从未成功进入 `verify_candidate`** |

### Step 4 主因

大量 `stage_plugin_changes` 工具参数 JSON 解析失败（单次 payload ≈16–23KB），协议错误反复回喂消耗调用额度；偶发 stage 成功后继续改写/再 stage，未调用验证门禁。

## 更早轮次（摘要）

- Run A：180s 默认时间预算过紧（≈¥0.83）
- Run B：Gate3 DI 误用耗尽 12 calls（≈¥5.52）
- 零付费修补：升高真机 per-run 预算、fail-closed 退出、SYSTEM_PROMPT 契约测试走 HTTP

## 下一轮建议（需再次显式授权）

1. 将 per-run `callLimit` 提到 ≥30，并在提示中要求：按插件分批 stage、stage 成功后立刻 `verify_candidate`、避免超大单次 JSON。
2. 外层可维持 `--max-calls=72 --max-cost-cny=40`（本轮外层仍有余量）。
