# round-7 33>30 零模型重放

观察：2026-11-06。分支 tip 相对 `2e9b073`。未发起付费模型调用。

## 证据

- 阻塞 run：`docs/reports/r11-20261104/bounded-probe-beca405-outcome.json`（`stop.diagnostic`）。
- `.runtime/.../bounded-probe-beca405-20261105T160111Z` 不在本工作区；诊断里 `plans: []`，没有 DeepSeek 的 33 条 `propose_plan` 草案，不能按原 payload 逐条重放。

## 夹具做了什么

`tests/app/round7-disable-tags-replay.test.ts` 两条路径，都走 `compileReferences` → `parseBrowserCases` → `inheritBrowserCases` → `dedupeBrowserCases`：

1. 从 outcome 抽出 `v1Requests[4]` / `plan-compilation` / 「33 条，最多 30 条」。
2. 按 v1Requests 0→4 喂冻结 acceptance（标签 → 计数 → 小写 → 复盘 → 停用标签）。
3. 再把同字段、不同 `obligation-*` ID 的投影副本叠进停用标签基线（付费提案常见的身份分叉）。

断言：`browserCases.length <= 30`；`browser/1` 无悬空 `caseId`；`obligationCases` 必须仍在或显式别名到内容等价存活案例；该诊断不得走可重试 `plan-compilation` 把 planning 推到 3。`assertNoDanglingBrowserChecks` 仍是硬门禁。

## 本 tip 结果

- 路径 2 的干净 0→4 链在改代码前已 ≤30（停用标签约 13 条量级），**不能**据此说付费 round-7 的 33 条提案已消失。
- 路径 3 在改代码前失败：同字段不同义务 ID 生成不同 `${obligation.id}-*` 案例；去重后 checks / `obligationCases` 仍要被丢的 ID。这就是复盘里的四层身份问题。
- 因此做了产品修正，不是再加一层内容哈希启发式：
  - `browserCaseStem`：field/history 案例 ID 按 `{kind,member,field,contribution}` 生成，派生副本不再另起 ID。history 与 field 仍分键。
  - 同 ID 冲突比较用 `browserCaseAssertionHash`（不含 `obligationId`）；`obligationId` 只作出处。
  - 超限改为 `PlanStructureBlocked`：`planningStructureTerminal({structural:true})` 第一次即终止，不再靠第二轮 `propose_plan`。
  - inherit 之后若仍有悬空 `browser/1`，`retryable=false`。

未提高 30 上限，未放宽验收义务，未跑付费六步。
