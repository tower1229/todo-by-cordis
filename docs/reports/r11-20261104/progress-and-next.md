# r11 收口进度与下一步（2026-11-11）

基线 tip：以 `dev` / `master` 对齐的最新合入为准。判断标准见根目录 [`CONTEXT.md`](../../../CONTEXT.md)：核心是模型驱动的自迭代架构；Todo 只是验证沙盘。

## 1. 已收口

| 主题 | 证据 |
| --- | --- |
| 浏览器案例身份收缩 | #52/#53 → 主线；stem/quota/host-snapshot supersede；上限仍 30 |
| 零付费 0→5（含停用/启用标签） | `round7` / `round9` replay 门禁 |
| round-10 真实复盘 `33>30` | #56 零付费 call-565 夹具消除并合入 |
| 策略债 #54 | 保留 `8b18866` 最短历史路径；撤回 `6bacd68` revises→新增（#57） |
| 付费六步系列 | `STOP_SERIES`（round-9/10 同类 `plan-compilation`）；默认不开 round-11 |
| 安全 | #58 `@hono/node-server` 2.1.3 |
| 演示域表述 | #59：改写为「演示域扩张纪律」，非 Todo 产品开关 |
| Issue / PR 队列 | 以当前 GitHub 为准 |
| 分支 | `dev`＝日常 tip；与 `master` 定期快进对齐 |

## 2. 仍未声称

- 真实模型完整六步通过数仍为 **0**（有意停付费，不是本轮缺口单）。
- 未把「零付费夹具绿」等同于「生产自迭代已可靠」。
- 演示域改动仅允许为验证自迭代所必需的最小夹具。
- 仓库仍可能有与主线正交的 Dependabot moderate 告警。

## 3. 分支约定（收束后）

| 分支 | 角色 |
| --- | --- |
| `dev` | **日常开发与合入目标**；自迭代相关改动默认从这里拉、往这里合 |
| `master` | 默认保护/发布指针；与 `dev` 定期快进对齐，避免长期分叉 |
| 功能枝 | 短命：`dev` 上开、合回 `dev` 后删 |

## 4. 下一步推进方向（按自迭代收益排序）

不新开「Todo 功能交付」票。下一刀只服务自迭代有效性 / 可信性 / 接口简洁 / 可迁移。

1. **编译与继承不变量固化（零付费）** — **已完成**  
   - round-10 **不注入** `acceptanceReason` →「须说明验收修订原因」  
   - 补 reason → ≤30 / 无悬空 / `planningStructureTerminal`  
   - inherit 超限结构终态；series-stop §3 列入 round10  
   - 见 PR 合入记录与 `round10-review-cap-replay` / `browser-case-identity`

2. **模型驱动闭环的下一结构性缺口（零付费）** — **已完成（结论 A）**  
   - Issue [#62](https://github.com/tower1229/todo-by-cordis/issues/62)  
   - 结论：强化 **仅 plan 根** `acceptanceReason`，禁止 `requirements[]`；见 [`acceptance-reason-contract.md`](./acceptance-reason-contract.md)  
   - 夹具：`acceptance-reason-contract.test.ts` + 工具描述/schema 文案强化  

3. **单次付费确认（仅维护者授权）** — **已完成（非通过）**  
   - tip `6170cd7`；双 CI 绿后 extended-ms 单条六步（调用 566–573）  
   - **`33>30` 未复现**；新停点：验收义务未完整执行/断言已变化 → 规划 `blocked`  
   - 费用约 $11.96/$20；累计 573/650；**继续 STOP_SERIES**  
   - 见 `bounded-probe-6170cd7-outcome.json` / `post-gate-6170cd7-finish-report.json`

4. **Dependabot 剩余 moderate**  
   与自迭代主线正交；有空修，不插队挡架构刀。

## 6. 刚确认后的架构下一刀（零付费优先）

付费确认暴露的是 **action-visible 到达状态未进身份键**：同动作 open/done 两条可见性期望共用 stem/配额 → done 案例 supersede open → `obligationFailure` 误杀。  
**本刀已完成（零付费）**：`actionVisibleArrivalState` 写入 `browserCaseStem` + `browserCaseQuotaKey`；同态不同 setup 仍可覆盖；夹具见 `browser-case-identity`。系列保持 `STOP_SERIES`，不抬 30、不开付费。

## 5. 明确不做

- 不开 round-11 付费六步（除非维护者另授权）。
- 不以「完整六步真实通过」作为打开演示域功能的理由。
- 不单独规划 Todo 产品路线。
