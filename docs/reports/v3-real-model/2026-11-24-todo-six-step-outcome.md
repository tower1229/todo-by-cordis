# V3 Todo 六步真机验收 Outcome（2026-11-24）

## 结论

**通过（6/6）。** `todo-six-step` 六个步骤全部到达 `preview_ready` 并应用组合，每步均通过四道验证门禁，无协议错误、无预算耗尽、无 Gate 警告。`inventory-migration` 场景尚未跑真机，父 Issue [#66](https://github.com/tower1229/todo-by-cordis/issues/66) 保持 open。

## Run D — `2026-11-24T01-50-13-616Z`（本轮）

| 项 | 值 |
| --- | --- |
| 外层护栏 | `--max-calls=72 --max-cost-cny=40.0` |
| per-run Evolution | `callLimit=24`（本轮从 18 上调）/ `activeMsLimit=20min` |
| 总调用 | 41 |
| 总 tokens | prompt 1,853,114 / completion 197,838 |
| 估算费用 | ≈ ¥10.58 |
| 耗时 | ≈ 15 分钟（09:50–10:05） |
| 退出码 | 0（`assertRealModelScenarioPassed` 全步通过） |

| Step | 预期变更 | 实际 affectedPlugins | calls | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 新增 todo-tags | `todo-tags:added` | 11 | `preview_ready` → applied |
| 2 | 新增 todo-counter | `todo-counter:added` | 6 | `preview_ready` → applied |
| 3 | todo-tags 小写化 + 大小写不敏感 | `todo-tags:upgraded` | 8 | `preview_ready` → applied |
| 4 | todo-core 通用双端拦截接缝 + todo-review 复盘插件 | `todo-core:upgraded` + `todo-review:added` | 7 | `preview_ready` → applied |
| 5 | 禁用 todo-tags（数据保留） | `todo-tags:disabled` | 5 | `preview_ready` → applied |
| 6 | 重新启用 todo-tags | `todo-tags:enabled` | 4 | `preview_ready` → applied |

Step 4 结束时组合为 `cand-comp-73066098`（4 个活跃插件：todo-core / todo-tags / todo-counter / todo-review），截图见 [step-4.png](2026-11-24T01-50-13-616Z/todo-six-step/step-4.png)。

## 与 Run C 的对比（修复效果）

Run C 在 Step 4 以 18/18 调用耗尽、全程未进入 `verify_candidate`；本轮 Step 4 仅用 **7 calls** 一次通过。

对应零付费修复（提交 `229d8f0`）：

1. `stage_plugin_changes` 对同一 `pluginId` 支持增量合并 `name` / `dependencies` / `contractTypes` / `sourceFiles` / `testFiles`（含 baseline 与已 staged 包），模型可分批写入单文件，单次 payload 从 16–23KB 降到常规尺寸。
2. 无有效 `upserts` / `toggles` 时 fail-closed 返回 `ok: false` 并给出明确错误，不再静默空操作后重复盲目重写。
3. `parseToolArguments` 在 JSON 解析失败时附 `(near: …)` ±60 字符切片，模型可一次定位尾部多余 `}`。
4. `SYSTEM_PROMPT` 明确「分批 stage、stage 成功后立即 verify_candidate、不盲写」。

per-run `callLimit` 由 18 上调至 24（提交 `a0e5d67`）；本轮各步最大用量 11/24，余量充足。

## 累计真机费用

| 轮次 | calls | 估算费用 |
| --- | --- | --- |
| Run A | 3 | ≈ ¥0.83 |
| Run B | 12 | ≈ ¥5.52 |
| Run C | 36 | ≈ ¥13.21 |
| Run D（本轮） | 41 | ≈ ¥10.58 |
| **合计** | **92** | **≈ ¥30.14** |

## 产物归档

- 原始调用与截图：[docs/reports/v3-real-model/2026-11-24T01-50-13-616Z/](2026-11-24T01-50-13-616Z/)
- `summary.json`：六步 status / changeBrief / budget / events 全量记录
- `todo-six-step/calls.jsonl`：41 次请求-响应原文

## 下一步（需再次显式授权）

`inventory-migration` 场景仍缺真机证据，若要闭环父 Issue #66，需经用户明确授权后运行：

```sh
V3_REAL_MODEL_AUTHORIZED=1 pnpm accept:v3:real-model \
  --authorize-paid-run \
  --scenario=inventory-migration \
  --max-calls=72 \
  --max-cost-cny=40.0
```
