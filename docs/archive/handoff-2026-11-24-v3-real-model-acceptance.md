# V3 真机六步验收交接（2026-11-24）

交接日期：2026-11-24。仓库：`/Users/zangtao/Workspace/tower1229/todo-by-cordis`。

## 当前状态

- **Git 状态**：分支 `dev`，HEAD `8c7cf3f`，与 `origin/dev` 同步，工作区干净。
- **代码实现与确定性测试**：V3-T1 至 V3-T8 已全部落地，子 Issue [#67](https://github.com/tower1229/todo-by-cordis/issues/67)–[#74](https://github.com/tower1229/todo-by-cordis/issues/74) 已关闭；父 Issue [#66](https://github.com/tower1229/todo-by-cordis/issues/66) 保持 **open**，等待受控真机验收通过。
- **真机验收进展**：遵守 `STOP_SERIES` 纪律，当前**无进行中的付费调用**。三轮受控真机跑（Run A / B / C）均已归档，**最高进度 4/6（Step 1–3 通过并应用，Step 4 未完成）**；`inventory-migration` 场景尚未跑真机。
- **累计已用真机估算费用**：Run A ≈ ¥0.83（3 calls）+ Run B ≈ ¥5.52（12 calls）+ Run C ≈ ¥13.21（36 calls）≈ **¥19.56**（51 calls，按脚本保守上界估算）。

## 参考文档与证据入口（不重复抄录）

- 架构与规范：[AGENTS.md](../AGENTS.md)、[CONTEXT.md](../CONTEXT.md)、[DESIGN.md](../DESIGN.md)、[07-cordis-self-iteration-v3.md](engineering/07-cordis-self-iteration-v3.md)、[ADR-0006](adr/0006-dual-context-cordis-and-thin-supervisor.md)、[ADR-0007](adr/0007-executable-subgraph-verification-and-direct-preview.md)。
- 真机三轮汇总：[2026-11-23-todo-six-step-outcome.md](reports/v3-real-model/2026-11-23-todo-six-step-outcome.md)。
- 原始调用与截图归档：
  - Run A：[docs/reports/v3-real-model/2026-11-23T06-27-04-323Z/](reports/v3-real-model/2026-11-23T06-27-04-323Z/)
  - Run B：[docs/reports/v3-real-model/2026-11-23T06-32-19-170Z/](reports/v3-real-model/2026-11-23T06-32-19-170Z/)
  - Run C：[docs/reports/v3-real-model/2026-11-23T06-56-12-573Z/](reports/v3-real-model/2026-11-23T06-56-12-573Z/)
- 核心改动提交：`7319410`（统一 DeepSeek 多轮历史与真机入口）、`8c7cf3f`（升高真机 per-run 预算、fail-closed 退出、`SYSTEM_PROMPT` HTTP 契约测试规范）。

## Run C Step 4 卡点精准诊断（来自 `calls.jsonl` call #19–#36）

Run C 中 Step 1（7 calls）、Step 2（6 calls）、Step 3（5 calls）均成功通过四道门禁并应用。Step 4（`todo-core` 通用双端拦截接缝 + `todo-review` 复盘插件）在 18/18 次调用耗尽暂停，**全程从未进入 `verify_candidate`**。逐条复盘 `calls.jsonl` 确认两个高优先级缺陷：

1. **`stage_plugin_changes` 静默吞掉错误参数结构（Silent No-Op）**
   - 位置：`src/v3/evolution-loop.ts` `handleStagePluginChanges`（约第 1430–1517 行）。
   - 实证：call #24、#29、#36 中模型输出了 `{ "arguments": { "upserts": [...] } }`（多套一层 `arguments`），函数未找到顶层 `upserts`/`toggles`，却返回 `{ ok: true, stagedPlugins: [], toggledPlugins: [] }`。模型随后 `inspect_plugin` 发现未生效，又触发新一轮大 JSON 重写。
   - 建议修复：若 `stagedIds.length === 0 && toggledIds.length === 0`，返回 `{ ok: false, error: "..." }` 明确指出缺少顶层 `upserts` 或 `toggles` 字段（不要静默返回 `ok: true`）。

2. **整包全量覆写 + 超大单次 JSON 导致 DeepSeek 尾部多吐 `}`**
   - 实证：Step 4 中 call #23、#27、#28、#30、#31、#34、#35 共 7 次出现完全相同的 JSON 语法错——`Unexpected non-whitespace character after JSON`（尾部多出一个 `}`，形如 `"}}]}}`），载荷均在 16KB–23KB 之间；另 call #22 出现数组元素分隔错误。
   - 原因之一：`handleStagePluginChanges`（约第 1475–1482 行）每次 upsert 直接全量覆盖 `nextUpserts[pluginId]`（不会合并已有 `sourceFiles` / `testFiles`），逼迫模型每次在单次 JSON 中一次性吐出整个插件全部文件。
   - 建议修复（优先度从高到低）：
     - 在 `handleStagePluginChanges` 中对同一 `pluginId` 支持**增量合并**已有 staged（或 baseline）的 `sourceFiles` / `testFiles` / `contractTypes` / `dependencies`（仅覆盖本次传入的字段/文件），使模型可分批写入单个文件，大幅降低单次 JSON 体积。
     - 在 `SYSTEM_PROMPT`（`src/v3/evolution-loop.ts`）中明确：按插件/文件分小批调用 `stage_plugin_changes`，stage 成功后立即调用 `verify_candidate`，不要重复盲写。
     - 可评估在协议层（`src/v3/evolution-loop.ts` / `src/v3/deepseek-driver.ts`）是否保持严格 JSON 校验（不建议无条件魔改 JSON，但需明确给出位置片段反馈，当前 `protocolErrors` 仅给位置号、未给出错上下文片段，模型连续 3 次在 22694 位置犯完全相同的错）。

3. **真机 per-run 预算余量**
   - `scripts/accept-v3-real-model.ts` 当前 `REAL_MODEL_EVOLUTION_BUDGET` 为 `{ callLimit: 18, activeMsLimit: 20 * 60_000 }`。若上述两项修好，18–24 calls 对单步已足够；如仍希望留足安全垫，可调至 `callLimit: 24`（外层 `--max-calls` / `--max-cost-cny` 仍严格封顶）。

## 下一会话建议步骤

1. **零付费修复与回归测试**（不触发任何真机 API 调用）：
   - 修复 `handleStagePluginChanges` 空操作返回 `ok: false` + 明确错误提示；支持同一 `pluginId` 增量合并字段/文件（注意检查是否影响 `tests/app/v3-evolution-loop.test.ts` 中现有契约）。
   - 优化 `protocolErrors` 反馈内容：在 JSON 解析报错时附带错误位置前后少量字符切片（如 ±60 chars），帮助模型一次定位尾部多余 `}`。
   - 在 `SYSTEM_PROMPT` 补充“分小批 stage、stage 后立即 `verify_candidate`”指导。
   - 补充单元测试覆盖上述三点，跑全量零付费验证：`pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e`。
   - 提交并推送至 `dev`，确认 CI 全绿。
2. **向用户请求单次显式授权后再跑真机验收**（严守 `STOP_SERIES`，未经用户明确授权不得运行）：
   - 建议先跑 `todo-six-step`：
     ```sh
     V3_REAL_MODEL_AUTHORIZED=1 pnpm accept:v3:real-model \
       --authorize-paid-run \
       --scenario=todo-six-step \
       --max-calls=72 \
       --max-cost-cny=40.0
     ```
   - 若 `todo-six-step` 6/6 全部通过，再视用户授权决定是否继续跑 `--scenario=inventory-migration` 并更新/关闭父 Issue [#66](https://github.com/tower1229/todo-by-cordis/issues/66)。

## 建议下一会话使用的 Skills

- `tdd`：用于先为 `stage_plugin_changes` 增量合并、非空参数校验与 JSON 报错切片反馈补齐零付费回归测试，再实施修复。
- `code-review`：在零付费修复完成、申请下一轮真机授权前，对照 `07-cordis-self-iteration-v3.md` 与 `AGENTS.md` 做一次双轴自检。
- `diagnosing-bugs`：若下一轮真机验收在 Step 4–6 或 `inventory-migration` 出现新的门禁失败，按假设-证据循环排查 `calls.jsonl` 与 Gate 日志。
