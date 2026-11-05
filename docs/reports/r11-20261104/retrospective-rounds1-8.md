# r11 付费六步复盘（round 1–8）

观察截止：2026-11-05 23:53Z。分支 `codex/model-interface-contraction`（HEAD `2b9e5af`），PR #52。只读整理；本文件是本轮唯一新增产物。未改源码或测试，未发起付费模型调用。

**结论先讲：** 七轮会触发代码修复的付费六步全部在规划编译门禁失败，完整六步通过数仍为 0。保护占额约 **$10.38 / $20**。失败没有收敛到模型质量，而是在验收义务 / 浏览器案例身份上换一类编译错误。不建议现在续跑付费；应先做针对性的身份与覆盖率不变量，再用零付费夹具挡住下一类编译失败。

## 0. 编号、范围与证据强度

`status.md` 把抬天花板之后的 extended-ms 探针编为 round-1…7。用户给出的修复序列从 `e655fee` 起算，共七次「失败 → 改代码」。二者差在：`afde277` 在 round-1 之前；`b7e9965` / `4df0cf4` 是额度与时间窗，不是产品编译补丁。下表两套编号并列，不合并。

六步请求原文（`scripts/lib/v1-scenario.ts` `v1Requests`）：

| 索引 | 请求 |
| --- | --- |
| 0 | 增加标签插件 |
| 1 | 增加独立计数插件 |
| 2 | 标签保存改为小写 |
| 3 | 完成前必须填写复盘 |
| 4 | 停用标签插件，保留数据/计数/复盘 |
| 5 | 重新启用标签插件 |

探针 JSON 里的 `phase-N` 是已应用截图序号，约等于上表索引。PR 正文曾把停用标签写成「phase-3」，与 `v1Requests[4]` 和 round-7 诊断原文不一致；本文件以请求原文和 outcome 截图为准。

证据层级：

- 强：本目录 outcome JSON、`status.md`、git 提交说明、GitHub Actions 失败名。
- 弱：调用 309–394 为缺席台账；供应商账单未知；费用是峰值估算 + 未知预留。
- 被改写：`bounded-probe-1416f54-outcome.json` 在 `beca405` 被换成事后分析（诊断字段还混入了 round-5 的「同一字段验收义务冲突」）。探针原件在 `ade9051`。下文 round-6 以 `ade9051` 与 `status.md` 为准。
- 未付费验证：`2b9e5af`。写本文时 push `42129403305` / PR `42129418845` 仍 `in_progress`。

未跑：双完整六步、`pnpm accept:v1 --authorize-real-model`、stock r11 runner 的 chains/performance。没有生产部署。

## 1. 每轮探针与每次修复

分类三档：

- **持久正确性**：不依赖 30 条上限或某一根测试的产品规则，后面也未被更强补丁替换。
- **上限/测试驱动**：主要为了 ≤30、`planning === 2` 或某一回归夹具。
- **失败推测**：提交说明与后来证据矛盾，或 CI/本地未兑现其声称的根因。

「取代」指后续提交改了同一条哈希/去重语义；没有一次 `git revert`。

### 1.1 付费探针

| 探针 tip | status.md | 调用 | 费用护栏（累计） | 已应用截图 | 停止时所规划 | 症状 | 完整六步 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `afde277` | 有界探针 | 395–403（9） | $6.53 | 1 次 applied | 计数相关规划 | 「既有字段的宿主派生义务无法重新绑定」 | 否 |
| `b7e9965` | 最小探针 | 404–405（2） | $6.56 | 未到 phase-1 门禁 | 第一步 planning+review 之后 | 累计天花板 405，请求第 406 次失败 | 否 |
| `4df0cf4` | **round-1** | 406–431（26） | $8.00 | phase-0…3 | 阶段时间窗（非编译） | 「本阶段已用完模型时间窗口」 | 否 |
| `5ce3a43` | **round-2** | 432–441（10） | $8.18 | phase-0 | phase-1 | 「业务修订引用的既有要求不存在」 | 否 |
| `6bacd68` | **round-3** | 442–454（13） | $8.43 | phase-0/1 | phase-2 | 「历史准备无法由基础版本唯一推导：tag:tag」 | 否 |
| `8b18866` | **round-4** | 455–467（13） | $8.76 | phase-0/1/2 | phase-3 | 「浏览器验收案例超出上限：34 条，最多 30 条」 | 否 |
| `dad4a6f` | **round-5** | 468–478（11） | $8.99 | phase-0/1 | phase-2 | 「同一字段验收义务发生冲突」 | 否 |
| `1416f54` | **round-6** | 479–498（20） | $9.51 | phase-0/1/2 | phase-3 | 「冻结验收自相冲突」（保护案例 complete 无 input vs 复盘 input-required） | 否 |
| `beca405` | **round-7** | 499–523（25） | **$10.38** | phase-0…3（4 张图，5 次 applied） | **停用标签**（`v1Requests[4]`） | 「浏览器验收案例超出上限：33 条，最多 30 条」 | 否 |
| `2b9e5af` | **round-8** | 未启动 | 同 round-7 | — | — | 未付费。本地声称修了桩的第三次规划，不是 round-7 的 33 条 payload 重放 | 仍为 0 |

round-1 的时间窗被探针本地 `v1-scenario-extended-ms`（1.8e6 ms）绕过，产品 `scripts/lib/v1-scenario.ts` 未改。之后每一轮失败都是新的 `plan-compilation` 诊断；旧诊断在 outcome 里标记为未复现，**不等于**在原失败位点被回归过。

### 1.2 代码修复

| 提交 | 针对 | 根因（仓库内可核对） | 修复 | 分类 | 后来 |
| --- | --- | --- | --- | --- | --- |
| `e655fee` | `afde277` 重绑定 | `compileReferences` 对所有派生字段用当前提案 `memberCases` 再生；加 counter 时 tags 成员案例不在提案里 | 成员未触及则保留派生字段，只对案例变化的成员重绑 | **持久正确性** | 保留。`1dae482` 只收窄 `reboundFields` 类型 |
| `1dae482` | `e655fee` 后 CI typecheck | 验证后数组元素仍是 `FieldObligation \| undefined` | 显式收窄 | 类型修补 | 保留 |
| `6bacd68` | round-2 缺失修订目标 | `revises` 在 `previous.requirements` 按 sourceQuote+type 找不到就致命抛错 | 找不到则当新要求发新 ID；歧义与来源新旧检查仍在 | **带产品取舍的降级**。不再强制修订必须命中旧身份 | 保留，未被回归打回 |
| `8b18866` | round-3 `tag:tag` | `historicalPreparation` 在 `results.size > 1` 时阻塞（「不能伪造历史或降低要求」） | 最短路径，平局按 `sourceHash` 字典序 | **策略变更**。用确定性选择换掉唯一性门禁；真矛盾（冻结成功期望不唯一、不可达）仍阻塞 | 保留 |
| `dad4a6f` | round-4 34>30 | 声称内容相同、义务 ID 不同的案例在累积 | `bound.filter` 用 **`hash(other)===hash(c)`**，哈希含 `id`/`obligationId`，不同 ID 根本去不掉 | **上限驱动且未打中机制**。回归只喂给 `compileReferences`，不经过后来真正涨条数的 inherit 合并 | 语义被 `dcad94c` 起的内容哈希取代 |
| `5476925` | round-5 同字段冲突 | `canPreserve` 与 `deriveFieldObligations` 投影同 `obligation.id`、不同内容，一起推进 `replacement.obligations` | 过滤与 `allRebound` 同 ID 的 regenerated | **持久正确性**（同一字段身份不得两份冲突义务） | 保留 |
| `beca405` | round-6 冻结自冲突 | workflow 从无字段升到必填 `review` 后，新 `workflow-input` 案例与继承的 `system-protection`（complete 无 input）同 ID 不同内容 | `workflow-input` 覆盖 `system-protection` | **持久正确性**（当前冻结工作流契约优先于旧保护断言） | 保留。副作用：改写了 1416f54 outcome 文件 |
| `dcad94c` | round-7 33>30 | `dad4a6f` 全量哈希去不掉同内容不同 ID | 内容哈希丢掉 `id` **和** `obligationId` | **上限驱动、过宽** | CI **7 fail**（见下）。被 `0b43b52` 改哈希 |
| `0b43b52` | 上列 7 个失败 | 不含 `obligationId` 时，历史义务与字段义务在 task/steps/prepare 相同会被捏成一条 | 哈希始终带 `obligationId` | **测试驱动** | CI 仍 2 fail（`3 !== 2`）。被 `ca99d67` 收窄 |
| `ca99d67` | 既要历史分离又要 ≤30 | 全局带 `obligationId` 又让非历史案例去不掉 | 有 `prepare` 才带 `obligationId` | **上限/测试启发式** | 仍在 `browserCaseContentHash`。未修掉两次桩失败 |
| `84b9f30` | 仍 `planning===3` | 声称 `inheritBrowserCases` 之后再次超过 30，`parseBrowserCases` 抛错被 Evolution 当成可重试 | `evolution.ts` 在 inherit 后再做一次内容去重 | **失败推测**。`2b9e5af` 说明那两个桩编译时只有 12–14 条，不是 >30。代码仍在，不是根因 | 未 revert；被真正根因说明证伪 |
| `2b9e5af` | 两次桩 `planning===3` | 派生 vs 非派生同一字段在挂历史时用不同输入哈希 scenario id（`{scenario,id,history}` vs `{steps,history}`），得到两套 `after-*`；内容去重丢掉派生那套，`requirement.checks` / `obligationCases` 仍引用被丢 ID；覆盖率当成可重试 → 第三次规划 | scenario id 只哈希 steps+history；去重后 remap checks；`obligationFailure` 接受内容等价的存活案例 | **持久正确性**（案例身份不该取决于 derivation 出处；检查必须指向还在的案例） | **未付费验证**。它修的是桩的第三次规划，不是 round-7 那份 33 条真实提案的重放 |

`dcad94c` 的 7 个失败（Actions `42065820393`，`ℹ fail 7`）：

1. `归档可见性误判离线重放…`（`baseline-review.test.ts`，`3 !== 2`）
2. `历史数据由基础页面真实动作准备…`
3. `历史期望自动绑定补充案例…`
4. `同步替换义务与案例的旧值仍不能绕过原冻结身份检查`
5. `独立历史义务只产生已有任务检查…`
6. `历史义务排在展示义务之前…`
7. `模型桩闭环：不可执行反馈…`（`operation-feedback.test.ts`，`不应以多轮规划重试制造通过` / `3 !== 2`）

`0b43b52` / `ca99d67` / `84b9f30` 均 `ℹ fail 2`，就是上面的 1 和 7。

## 2. 失败落在哪一阶段（趋势）

| 轮 | 已应用步数（截图） | 停止相位 | 停止类型 | 相对上一轮 |
| --- | --- | --- | --- | --- |
| 有界 `afde277` | 1 | 规划编译 | 派生重绑定 | — |
| 最小 `b7e9965` | 0 | 计量 | 天花板 405 | 装不下验证 `e655fee` |
| round-1 | 4 | 时间窗 | harness | 重绑定未复现；产品编译尚未成为瓶颈 |
| round-2 | 1 | phase-1 规划 | 修订目标缺失 | 延长时间窗后**立刻**回到编译门禁，进度回退 |
| round-3 | 2 | phase-2 规划 | 历史不唯一 | +1 步 |
| round-4 | 3 | phase-3 规划 | 34>30 | +1 步 |
| round-5 | 2 | phase-2 规划 | 同字段义务冲突 | **回退 1 步**。34>30 未在原位点复验 |
| round-6 | 3 | phase-3 规划 | 冻结自冲突 | 回到 round-4 的步数，换诊断 |
| round-7 | 4 | 停用标签规划 | 33>30 | 最远的编译失败；**34>30 以 33>30 形式在更后一步重现** |
| round-8 | — | 未跑 | — | — |

趋势判断（不夸大）：

- 从 round-2 起，付费预算主要买到了 **下一类 `plan-compilation` 诊断**，不是模型走完六步的能力。
- 已应用步数不是单调的。round-5 说明「上一诊断未复现」可以只是死得更早。
- round-4 与 round-7 是同一类上限错误（34 与 33）。中间三轮补丁没有消灭「多义务投影 × 硬上限 30」。
- 最好的付费编译进度是 round-7：复盘已应用，停在停用标签。六步还剩启用标签。即使 `2b9e5af` 在真实停用标签上成立，后面仍有一步未付费见过。
- round-1 也曾应用 4 步，但停在时间窗。extended-ms 之后从未再走出停用标签规划。

每次付费调用数：9, 2, 26, 10, 13, 13, 11, 20, 25。round-7 最贵（本批约 $0.88），换来的仍是编译门禁。累计 523/650，剩余 127 次；约束是失败模式，不是次数。

## 3. 结构弱点（有证据）

### 3.1 浏览器案例身份不唯一、去重事后补

案例 ID 为 `` `${obligation.id}-${key}` ``（`src/shared/acceptance-obligations.ts`）。同一套 steps 只要来自不同义务就得到不同 ID。`inheritBrowserCases` 只按精确 ID 替换，对不上就把旧案例追加进去（`src/evolution/references.ts` 71–73 行）。

去重策略在一周内改了五次，全是同一函数上的补丁：

1. `dad4a6f`：全对象哈希（含 id）→ 去不掉
2. `dcad94c`：去掉 id 和 obligationId → 捏死历史 vs 字段
3. `0b43b52`：永远带 obligationId → 上限又回来
4. `ca99d67`：有 prepare 才带 obligationId → 启发式
5. `2b9e5af`：抽到 `browser-case-content.ts`，并 remap 检查

这不是「漏了一个 if」，是 **ID、内容、义务、派生出处四套身份并存**，没有先规定哪一层是规范化键。

### 3.2 硬上限 30 把生成爆炸变成可重试规划

```91:93:src/server/requirement-coverage.ts
export function parseBrowserCases(value: unknown): BrowserCase[] {
  if (Array.isArray(value) && value.length > 30)
    throw new Error(`浏览器验收案例超出上限：${value.length} 条，最多 30 条`);
```

Evolution 对 `parse` 抛错走 `retryProtocol`（`evolution.ts` 1720–1740 行），相同诊断才终端。所以 33/34 条在桩测试里表现为 `planning === 3`，在付费探针里表现为 planning-gate。上限本身没有产品说明为什么 30 够用；真实链在 tags+counter+复盘+停用 时两次撞上 33/34。要么生成重复，要么 30 不够多插件继承，或两者都有。现有测试几乎只断言 `length <= 30`，不断言「语义上不该再少」。

### 3.3 验收义务模型把冲突推迟到案例层

并行存在且会为同一 UI 字段出案例的种类包括：`field`（含 `derivation`）、`history`、`workflow-input`、`assertion`（`system-protection` / `frozen-business`）。冲突检测是「同案例 ID、不同 `hash`」（`references.ts` 642–659 行）。于是出现：

- 同 ID 不同内容 → 抛「同一字段验收义务冲突」或「冻结验收自相冲突」
- 不同 ID 相同内容 → 涨条数直到 30
- 派生与非派生哈希不同 → 两套 `after-*`，去重后再留下悬空检查

`5476925` 和 `beca405` 各补了一种冲突的局部优先级，没有一张「字段身份 → 唯一规范化义务 → 唯一案例键」的表。

### 3.4 覆盖率按 ID 记账，去重按内容扔案例

`2b9e5af` 之前，`requirement.checks` 写入生成时的 `c.id`，去重只滤 `browserCases`。丢 ID 后 `obligationFailure` 报「验收义务未完整执行或断言已变化」，该诊断可重试。这是 `84b9f30` 猜错根因的直接原因：条数是 12–14，第三次规划来自悬空引用，不是 30 上限。

`inherited-field-projection.test.ts` 的 disable-tags ≤30 夹具在 `2b9e5af` 之前**不检查** checks 是否仍指向存活案例。`assertNoDanglingBrowserChecks` 是事后补上的。零付费测试当时测了上限，没测覆盖率闭合。

### 3.5 回归夹具打不中付费路径

| 夹具 | 实际挡住了什么 | 没挡住什么 |
| --- | --- | --- |
| `inherited-field-projection` 34>30 模拟 | `compileReferences` 输出 ≤30 | inherit 合并、真实 33 条提案、全对象哈希无效 |
| disable-tags ≤30 模拟（`dcad94c`） | 多需求投影的条数 | 历史 vs 字段；悬空 `after-*` |
| `same-field-obligation-conflict` | canPreserve 与 regenerated 同 ID | 冻结保护 vs workflow-input |
| `workflow-input-system-protection-conflict` | 一种 supersede | 案例膨胀 |
| `baseline-review` / `operation-feedback` `planning===3` | 第三次规划 | 前四次补丁都猜错原因，直到 `2b9e5af` |
| `v1-acceptance` 模型桩六步 | 夹具 driver 能走完 | DeepSeek 真实 `propose_plan` 的义务编译 |

因此：**CI 绿不能预测下一轮付费编译门禁。** round-2…7 都是双 CI 绿之后立刻用真实模型撞上新诊断。

### 3.6 降级补丁在积累策略债务

`6bacd68`（修订变新增）和 `8b18866`（多历史取最短）都把原来的致命不变量改成继续走。它们让后面的轮次发生，也让义务图更杂（更多并存要求、更多可达史）。后面的 30 上限与同字段冲突，部分就是这条链走出来的。不是说必须撤回，但续跑付费等于在已放松的不变量上继续堆启发式。

## 4. 建议

### 4.1 现在不要续跑付费

理由都是已经发生的事实，不是估工期：

1. 七次「失败 → 补丁 → 再付费」没有一次完整六步；从 round-2 起失败类全是宿主编译，不是生成质量。
2. 同一上限错误出现两次（34 与 33），中间夹着三次其它编译补丁。
3. round-7 之后四次提交 CI 红，第五次才说清桩失败；该第五次**还没**用 round-7 的真实提案验证 33>30 是否消失。
4. 费用护栏还剩约 $9.62，调用还剩 127/650。钱和次数不是瓶颈。再付费很大概率再买一条新的 `plan-compilation` 诊断。
5. `CONTEXT.md` 不以单次模型成功代替架构有效性。当前有效信息是：案例/义务身份模型在多插件继承下不稳定。

### 4.2 先做的针对性改动（仍是建议，本轮未改代码）

优先规范化，而不是再给哈希加一个字段：

1. **单一案例键**：同一字段身份 + 同一 task + 同一 steps + 同一 prepare（历史）只允许一个案例 ID；derivation 不得另编 `after-*`。`2b9e5af` 走了一步，但内容去重仍是事后折叠。
2. **生成后不变量**（编译结束必须成立，失败不可重试）：每条 `browser/1` check 的 `caseId` 存在于 `browserCases`；每个 `obligationCases(o)` 要么仍在，要么显式别名到内容等价案例；`length <= 30` 只是其中一条。
3. **上限策略**：要么证明 30 是产品约束并在生成侧裁剪（按字段身份配额），要么提高上限并同步测试。不要靠去重碰运气压到 29。
4. **`parseBrowserCases` 超限 / 悬空引用不要当协议重试。** 现在这会把结构错误翻译成第三次 `propose_plan`。

这些是身份模型收缩，不是再打一轮「disable-tags 专用」补丁。

### 4.3 付费前可以用的零成本检查

不需要 DeepSeek，也不需要 Mac 密钥：

1. **等 `2b9e5af` CI 双绿。** 写本文时仍在跑。红则先修桩，不要付费。
2. **重放 round-7 阻塞提案。** `bounded-probe-beca405-outcome.json` 的 `stop.diagnostic` 里有完整 blocked run（含 `baseVersion`、成员哈希、停用标签原文）。把它做成 `compileReferences` + `inheritBrowserCases` + `parseBrowserCases` 夹具：断言 ≤30、无悬空 check、`planning` 不会因该诊断走到 3。这比再花 ~$0.9 看同一句中文便宜。
3. **六步继承链的零模型编译。** 按 `v1Requests` 0→4 逐步喂冻结 acceptance（可用已有 stub 的 applied 快照或手写最小义务图），每步跑编译不变量。现有 `v1-acceptance` 桩用的是夹具 driver，打不中真实义务展开。
4. **保留并强制** `assertNoDanglingBrowserChecks`、历史 vs 字段分离、`planning === 2` 三条，作为合并门禁，而不是事后补。
5. **不要用「条数 ≤30」单独放行。** `84b9f30` 已经证明 12–14 条仍会第三次规划。

### 4.4 停止条件（具体）

满足任一条就不要开下一轮付费六步：

| 条件 | 动作 |
| --- | --- |
| `2b9e5af` CI 未绿 | 不开 |
| 没有「停用标签」继承链的零模型编译夹具，或该夹具仍超 30 / 仍有悬空 check / 仍会第三次规划 | 不开 |
| 夹具绿之后，**最多 1 次**付费确认轮（只验证模型协议与时间窗，不再发现新的 `plan-compilation`） | 开这一次 |
| 该确认轮再次死在新的 `plan-compilation` 诊断 | **停止系列**，改身份模型，不要再补丁→付费 |
| 该确认轮走到停用标签之后、又死在启用标签或其它编译门禁 | 同样停止系列 |
| 确认轮因协议/时间窗/模型内容失败 | 可另议 harness 或模型，那已不是本复盘这类编译债 |
| 确认轮仍 `completeSixStepPass === 0` | 不把「更远一步」当成续跑理由 |
| 保护占额再增加却没有完整六步 | 停止。本系列已经用约 $10.38 买了七类编译诊断 |

明确不构成续跑理由：CI 绿、某一旧诊断「未复现」、费用未到 $20、调用未到 650、本地两个桩变绿。

## 5. 本轮未验证

- `2b9e5af` 的 GitHub CI 结果（当时 in_progress）。
- 真实 DeepSeek 在 `2b9e5af` 上是否还能打出 33>30，或打出下一句编译诊断。
- 供应商实际账单。
- 双六步、生产 admit、产品时间窗（1.8e6 只在探针 harness）。

以上足够支持「先停付费、先收身份模型」；不足以声称 round-7 已修好，也不足以声称下一轮会通过。
