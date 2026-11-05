# r11 续跑停止报告

观察时间：2026-11-04 08:52Z。分支 `codex/model-interface-contraction`。本报告只记录已经发生的结果。

## r10 压缩包

四个分卷的 sha256 均与 `SHA256SUMS` 一致，已用 `cat r10-part0*.gz | tar -xzf - -C .runtime/` 解压。目录 `.runtime/continuous-revision-study-20261104-r10` 有 1707 个文件，被 `.gitignore` 忽略，没有进入 Git。检查后目录改为只读，`real/targeted` 和 `real/chains` 没有重开。

r10 封存的是提交 `608280e`、累计 292、剩余 113。v2 审计器 `audit-outbound-payload.mjs`、`audit-targeted-v2.py`、`audit-real-study-v2.py` 都在包内。包内没有 30 份更早付费台账、6580 个用户本机绝对路径依赖、两份基线 `workspace.db`，也没有 `.env`。这两份数据库的冻结哈希分别是 `76b1da827ae853280f15f610c0a8c4a05bfedad17a00f73a7dc507d376bfc08d` 和 `93fa8ce2921a1b36cb298b0598114fa6619cec0d61b3295516f980ef0fceed4b`。没有按哈希补造文件。

## 分类结果

| 类别 | 结果 |
| --- | --- |
| 代码实现 | 字段投影修复在 `80e0487`。生产 `admit` 没有放宽。`60a9e01` 让真实六步链只按暂停最小值追加调用，并带有测试 |
| 本地回归 | 交接中的 118/118 日志不在这四卷里。本机已安装 Node v24.18.0，并完成本地 build；没有重跑 857 项应用测试 |
| 精确提交 CI | 续跑绑定 `60a9e01`。pull_request [41900276701](https://github.com/tower1229/todo-by-cordis/actions/runs/41900276701) 的日志：应用 tests 859、pass 859、fail 0、cancelled 0、skipped 0；E2E 111 passed。同提交 push [41900268049](https://github.com/tower1229/todo-by-cordis/actions/runs/41900268049) 的日志同样是 859/859、fail 0、cancelled 0、skipped 0，E2E 111 passed。更早的 `b50a7f1` 日志仍是 857/857 与 E2E 111 |
| 模型桩 | `5bb228d` 上 52/52 零付费预演保持原审计，没有重跑。这不是真实模型通过 |
| 真实定向 | 通过。调用 293–295，共 3 次，用量均已知。`actualModel` 为 deepseek-flash |
| 完整真实链 | 仍没有一条完整六步通过。定向之后共 86 次链上调用，分布在 7 次尝试。最好的一次完成前四步，停在停用标签的复核冲突 |
| 策略对照 | 四个臂都启动了。high/high 两次完整路径通过。两次 max 都停在阶段时间预留，完整路径没有通过 |
| 费用估算与账单 | 策略臂结束后已知用量估算 4.470210864 美元，未知预留 1.8874368 美元，保护占额 6.357647664 美元。累计 394/405，剩余 11。20 美元上限没有挡住；剩下的 11 次调用装不下两条完整六步链。供应商账单未知 |
| 源码交付与生产部署 | 源码已在分支上。没有生产部署，也没有用户产品验收 |

## 预算更正

`BudgetScheduler.modelWindow` 在 600000ms 限额下，planning 的准入阈值是 235000ms。旧分析文案中的 256000ms 保留为历史说明，r10 封存文件没有被改写。阶段探针仍是反事实编译基线。

## 台账缺口

r10 目录现在在云端且只读。它记录累计 292、剩余 113、第 202 与 250 次未知用量。更早的 30 份逐次台账文件不在这四卷里，没有重建。r10 的 `real/targeted` 和 `real/chains` 没有重开。

## 付费前停止

2026-11-04 08:52:16Z 重新下载 https://status.deepseek.com/incidents/7202016104287 。可见文本为 Resolved，最近更新 2026-11-03 10:48:00Z。08:52:45Z 的原生路由是 direct，无凭证 GET `/models` 返回 HTTP 401，耗时 333ms，没有加载环境文件，付费调用为 0。这只证明连通。本环境没有 `DEEPSEEK_API_KEY`。

Node v24.18.0 本地构建的三个前端文件与 CI 资源名一致，sha256 在 `fresh-readiness.json`。r10 冻结的 79 个历史前端文件没有被拿来给这次构建补签。

当时 `node scripts/r11-real-phase-gate.mjs docs/reports/r11-20261104` 退出码 2。脚本没有读取密钥，也没有创建 `real/targeted` 或 `real/chains`。当时缺的是两份基线 `workspace.db` 和 `prepaid-rehearsal-audit.json`。

## 基线与 52 次零付费预演

两份冻结数据库已放到 `.runtime/continuous-revision-study-20261103/upgrade-baseline/workspace.db` 与 `.runtime/continuous-revision-study-20261103/counter-baseline/workspace.db`。sha256 分别为 `76b1da827ae853280f15f610c0a8c4a05bfedad17a00f73a7dc507d376bfc08d` 和 `93fa8ce2921a1b36cb298b0598114fa6619cec0d61b3295516f980ef0fceed4b`。预演前后内容哈希不变。它们属于 `.runtime`，没有进入 Git。文件保持所有者可写，这样运行器复制后的工作区数据库可以被 SQLite 打开。

预演身份是 `5bb228defb1b01f04e79130f7f08412b089b3309`，信封 v1。两次准备性启动没有计入这 52 次：第一次缺少从 r10 原样复制的 `upgrade-fixture.json`；第二次复制出的数据库仍是只读。两次付费调用都是 0。夹具复制后哈希与 r10 `prepaid-validation-sha256.json` 一致：`upgrade-fixture.json` 为 `5ac2355ced43b5eb1470dbca7036b6fb43cd5c23c7dd7604239276df05582973`，`raw189-proposal.json` 为 `fd5ae012ab3478771f0603eaec1371fc99ad9bc3cb173c3a5a94f8951441b120`。

随后一次完整预演退出码 0。runner 摘要：targeted 4 次、chains 36 次、performance 12 次，合计 52，`paidCalls` 0，`cumulativeOccupied` 292。四个策略臂都是桩的完整路径，用量未知，因为没有真实模型回执。`audit-rehearsal.py` 退出码 0，写出 `.runtime/continuous-revision-study-20261104-r11/prepaid-rehearsal-audit.json`。审计核对 854 个源文件、2 份现存 r10 台账、52 条线报、策略 high 46 / max 6、两条六步链各 6 次成功运行且追加预算为 0、定点独立后端 7 与浏览器案例 4。凭证扫描没有运行，因为没有读取 `.env`。`actualTokenCost` 为空。该文件标明 `notRealModelEvidence: true`。Git 中的副本是这份审计的原文拷贝。

本批新增付费调用仍是 0。累计占额、已知用量估算、未知预留和保护占额都没有变化。供应商账单仍然未知。30 份更早台账仍未重建。

## 付费目录继续关闭

预演审计落盘后，门禁改为：证据文件齐全时，仍必须显式传入 `--authorize-real-directories` 才会创建 `docs/reports/r11-20261104/real/targeted` 与 `real/chains`。本轮没有传入该参数，退出码 2，`keyRead` 为 false，目录未创建。没有读取 `DEEPSEEK_API_KEY`。08:52Z 的事故观察对以后的付费开始已经过期，下一次付费前必须重取。

六步链脚本 `scripts/lib/v1-scenario.ts` 仍在仓库中。下面是密钥就位后的真实阶段，不是对上面这段等待记录的改写。

## 2026-11-04 14:00Z 之后的真实阶段

付费身份是 `b50a7f1c9c0b1c9ddbfea4e7f8d86cd3c43174ed`。52 次预演仍绑定 `5bb228d` 的信封 `de05ec273ec4e7970b0fa2ba9702844854ca8a7f70439b9b3b7b10bc0fe0e890`，没有重跑。执行信封是 `10641da0417a6ad2166a5ba0ef417b86071253941dc094756714a82d2a44a691`。差别只在付费锁的解除，以及把提交、CI 和实际加载的环境文件重新绑定。云端 `.env` 与 r10 封存的本机环境文件哈希不一致，新哈希只留在被 gitignore 的配置里。

14:00:18Z 重新归档事故 7202016104287，状态 Resolved。同分钟的无凭证 `/models` 是 direct、HTTP 401。门禁命令带 `--authorize-real-directories`，退出码 0，创建了 `docs/reports/r11-20261104/real/targeted` 和 `real/chains`。这两个目录是空标记，Git 不保存空目录。真正的证据在 `.runtime/continuous-revision-study-20261104-r11/real/`。

真实定向退出码 0。三次调用都返回且用量已知。结果：独立后端 7，浏览器案例 4，来源绑定修订、体验、精确应用、历史数据、重启和精确恢复均为通过。本段已知用量估算增加 0.068901648 美元。

第一条真实六步链随后停止。诊断的第一句是「预算不足：剩余调用无法容纳完整需求复核与候选执行，保留原预算并停止规划」。范围 `six-step-1`，调用 296–308，共 13 次，用量都已知。没有 `result.json`。第二条链和四个策略臂没有启动。完整真实六步通过数仍为 0。失败原文留在运行目录，这里不转载。

本批结束后已知用量估算 2.573292372 美元，未知预留 0.9437184 美元，保护占额 3.517010772 美元，仍低于 20 美元上限。供应商账单未知。30 份更早台账仍未重建。没有生产部署。

## 预算诊断与调用再分配

第一条链的第二条运行停在调用预留，不是全局 308 次或 20 美元。`callsUsed` 为 8，授权 12，`callsRemaining` 为 4，候选还剩 3，活动时间还剩约 313923 毫秒。账本是 7 次规划加 1 次复核，和 `callsUsed` 一致，没有协议失败。规划准入要求剩余至少 `executionReserve + 2`，即 5 次；4 小于 5，所以下一次规划被拒绝。这和现有测试 `admit(8, "planning")` 抛错一致。复核有一条必填冲突，引用是「初始为零」。宿主接着要重新规划，而不是时间或候选耗尽。

暂停单的最小追加是 2 次调用，建议值是 6。最小追加来自 `used + 6 - limit`，其中 6 是规划恢复的固定提前量，比规划准入的 5 多 1。公开追加接口不能低于这个最小值。生产准入公式没有改。

真实六步链现在会按暂停单的最小值追加并继续，每个阶段最多 4 次，计入共享剩余调用。建议值 6 不使用。四个策略臂仍排在两条链之后。这条修正的 CI 通过之前不重新开付费。

## 2026-11-04 21:00Z 之后的续跑

`60a9e01` 的两份 CI 日志都是应用 859/859、fail 0，E2E 111 passed。付费身份改绑到这次提交。`src` 相对已通过的定向没有变化，定向没有重跑。第一次失败的链目录改名为 `chains-stopped-call-reserve`，13 次调用仍计入序号和费用。

追加逻辑在后来的尝试里没有碰到调用暂停。这些尝试停在别的原因上，都没有标成通过：

| 目录 | 调用 | 结果 |
| --- | --- | --- |
| `chains-stopped-call-reserve` | 296–308 | 单次运行 8/12，剩余 4，规划需要 5。调用预留 |
| `chains-protocol-20261104T2104Z` | 309–311 | 第 0 步模型协议未收敛，未授权字段 |
| `chains-history-20261104T2113Z` | 312–321 | 第 0、1 步已应用。第 2 步历史准备不唯一：`tags:tags` |
| `chains-review-gate-20261104T2124Z` | 322–329 | 第 0 步已应用。第 1 步复核重复，规划门禁 |
| `chains-disable-tag-review-20261104T2145Z` | 330–351 | 第 0–3 步已应用。第 4 步停用标签与仍保留的 `setTags` 检查冲突 |
| `chains-timeout-phase3-20261104T2216Z` | 352–370 | 第 0–2 步已应用。第 3 步 `[timeout/ETIMEDOUT] terminated`，其中 1 次用量未知 |
| `real/chains` | 371–381 | 第 0、1 步已应用。第 2 步历史准备不唯一：`counter:count` |

第二条六步链没有开始。完整六步通过数仍为 0。

此后剩余 24 次调用。按已观察到的步数，一条六步链在走到第 4 步时已经用了 22 次，24 次装不下两条完整链。剩下的调用改给四个策略臂，没有再开第六轮链。

四个臂都跑完一次，没有因为额度跳过：

| 臂 | 调用 | 结果 |
| --- | --- | --- |
| `performance-1-max` | 382 | 阶段时间预留。1 次用量未知。完整路径未通过 |
| `performance-2-high` | 383–385 | 完整路径通过 |
| `performance-3-high` | 386–390 | 完整路径通过 |
| `performance-4-max` | 391–394 | 阶段时间预留。完整路径未通过 |

策略臂汇总的 `passed` 为 false，因为两次 max 没有走完。结束时累计 394/405，剩余 11。已知用量估算 4.470210864 美元，未知预留 1.8874368 美元，保护占额 6.357647664 美元。20 美元不是停止原因。按前面六步链的实际消耗，剩下 11 次不够再完成两条六步链。供应商账单未知。没有生产部署。30 份更早台账仍未重建。

## 额度缺口后停止

308/405 是续跑开始前的累计。续跑已经发生，当前累计是 394/405，剩余 11 次。保护占额 6.357647664 美元，距 20 美元还剩 13.642352336 美元。费用不是缺口。

最好的一条链用了 22 次调用，只完成前四步（各步 5、4、4、6 次），第五步在规划门禁停下。按已成功步骤里最低的 4 次估算，一条六步也要 24 次，两条要 48 次。相对剩余 11 次，两条完整链至少还差 37 次调用。这 11 次不再开新的链或策略臂。完整六步通过数仍为 0。两次 high 臂的完整路径通过保持原记录，两次 max 臂的阶段时间预留也保持原记录。

## 2026-11-05 Mac 有界付费探针（afde277）

观察时间：2026-11-05 02:01–02:06Z（Asia/Shanghai 10:01–10:06）。分支 tip `afde277f70ba55bb73eef4a2b61e9285157a2255`。本机 `zangtaodeMacBook-Pro.local`。云端 agent 未重启。

### 账本继承（缺席台账风格）

`status.md` / PR #52 权威累计在探针开始前为 394/405，剩余 11。已知用量估算 4.470210864 美元，未知预留 1.8874368 美元，保护占额 6.357647664 美元。Mac 磁盘上的 `.runtime/.../real/` 仍只有早期包到调用 308；**不宣称** 309–394 的 attempt 目录存在于本机。309–394 按缺席台账并入 `priorGoal*`，弱于封存逐次目录的审计强度。绑定说明：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-afde277-bind.json`。

### 未跑项

未跑双完整六步链，未跑 `pnpm accept:v1 --authorize-real-model`，未跑 stock r11 `runner.ts` 的 chains/performance（本机缺少完整 envelope 依赖与 `/workspace` 路径密封，且缺 309–394 封存目录；父代理授权选项 2）。

### 探针结果

有界真实路径：单次 `runV1Acceptance`（`real-model-full-six-step`），硬顶 11 次新调用，序号从 395 起。Node v24.18.0。付费前刷新了事故观察（Resolved）与无凭证 `/models`（HTTP 401）。CI 绑定 push [41941921229](https://github.com/tower1229/todo-by-cordis/actions/runs/41941921229) / PR [41941928823](https://github.com/tower1229/todo-by-cordis/actions/runs/41941928823)（应用 864/864，E2E 111）。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-afde277-20261105T020119Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 9（序号 395–403，用量均已知） |
| 累计 | 403/405，剩余 2 |
| 已知用量估算 | 4.645160568 美元 |
| 未知预留 | 1.8874368 美元 |
| 保护占额 | 6.532597368 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 停止原因 | planning-gate / plan-compilation：既有字段的宿主派生义务无法重新绑定；须显式修订原要求，不能删除旧断言 |

事件可见一步已 `applied`，随后计数相关规划在宿主派生义务门禁停下。硬失败后未再消耗剩余 2 次。旧 `real/targeted` 与 `real/chains`（293–308）未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-afde277-outcome.json`。供应商账单未知。没有生产部署。

### 后续修复（e655fee / 1dae482）

根因定位：`src/evolution/references.ts` line 504-560 的重新编译逻辑对所有有派生字段的旧需求都尝试用当前提案的 memberCases 重新生成。当添加新插件（counter）时，当前提案只包含新插件的案例，旧插件（tags）依赖的成员案例缺失，导致派生字段无法匹配而抛出门禁错误。

修复：区分「需要重新绑定」和「可以保留」的派生字段。只对当前提案中触及且案例变化的成员进行重新绑定；对未触及或继承中的成员，直接保留原派生字段。提交 `e655fee` 包含修复代码和两项回归测试。`1dae482` 修复类型收窄（reboundFields 验证后显式转为 FieldObligation[]）。本地测试 field-reference-rebind.test.ts（15/15）、acceptance-obligations.test.ts（7/7）、historical-preparation.test.ts（7/7）通过，pnpm typecheck 通过。未跑真实模型验证。

## 2026-11-05 Mac 最小有界付费探针（b7e9965）

观察时间：2026-11-05 03:57Z（Asia/Shanghai 11:57）。分支 tip `b7e99651b9881ba359337eb1c8d08deb428bbd09`。本机 `zangtaodeMacBook-Pro.local`。

### CI 门禁

Push [41956504060](https://github.com/tower1229/todo-by-cordis/actions/runs/41956504060) 与 PR [41956509160](https://github.com/tower1229/todo-by-cordis/actions/runs/41956509160) 均 success（应用 866/866，E2E 111；push 完成 03:52:21Z，PR 完成 03:49:40Z）。付费前刷新了事故观察（Resolved）。

### 账本

探针开始前累计 403/405，剩余 2。已知用量估算 4.645160568 美元，未知预留 1.8874368 美元，保护占额 6.532597368 美元。缺席台账继承 309–394；afde277 证据 395–403 保留未覆盖。绑定：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-b7e9965-bind.json`。

### 探针结果

有界真实路径：单次 `runV1Acceptance`（`real-model-full-six-step`），硬顶 **2** 次新调用（序号 404–405）。Node v24.18.0。未跑双六步 / accept:v1 / stock runner。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-b7e9965-20261105T035722Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 2（序号 404–405，用量均已知；404 planning，405 review） |
| 累计 | 405/405，剩余 0 |
| 本批已知增量 | 0.027025379999999544 美元 |
| 已知用量估算 | 4.672185947999999 美元 |
| 未知预留 | 1.8874368 美元 |
| 保护占额 | 6.559622747999999 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 停止原因 | **meter-exhaust / cumulative-ceiling**：请求第 406 次调用时 `ordinal <= 405` 断言失败。未到达 phase1 宿主派生重绑定门禁，也未完成六步。 |

这是记录的非通过，不是伪造通过。先前 afde277 路径约需 9 次才碰到重绑定门禁；剩余 2 次不足以验证 e655fee/1dae482 修复。旧 `real/targeted`、`real/chains`、`real/bounded-probe-afde277-20261105T020119Z` 未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-b7e9965-outcome.json`。供应商账单未知。没有生产部署。

### 下一步阻塞（已被后续覆盖）

调用天花板 **405** 当时已占满。用户 t51u 随后授权提高合理调用上限；见下方 4df0cf4 提高天花板探针。

## 2026-11-05 Mac 提高天花板付费探针（4df0cf4）

观察时间：2026-11-05 05:19–05:51Z（Asia/Shanghai 13:19–13:51）。分支 tip `4df0cf44ccf71b748d11088e169e7ac99793f61f`。本机 `zangtaodeMacBook-Pro.local`。用户 t51u 授权付费验证且合理调用不设限；费用护栏仍为约 20 美元。

### CI 门禁

Push [41965019082](https://github.com/tower1229/todo-by-cordis/actions/runs/41965019082) 与 PR [41965027821](https://github.com/tower1229/todo-by-cordis/actions/runs/41965027821) 均 success（应用 866/866，E2E 111；push 完成 05:15:27Z，PR 完成 05:13:33Z）。付费前刷新了事故观察（Resolved，`incident-visible-20261105T0517Z.txt`）与无凭证 `/models`（HTTP 401）。

### 账本

探针开始前累计 **405/405**（旧天花板已满）。按 t51u 将累计天花板提高到 **650**，本批硬顶 245 次新调用，序号从 **406** 起。已知用量估算起点 4.672185947999999 美元，未知预留 1.8874368 美元，保护占额起点 6.559622747999999 美元。缺席台账继承 309–394；afde277 395–403 与 b7e9965 404–405 证据保留未覆盖。绑定：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-4df0cf4-bind.json`。

### 探针结果

有界真实路径：单次 `runV1Acceptance`（`real-model-full-six-step`），Node v24.18.0（`node --import tsx`）。未跑双六步 / accept:v1 / stock runner。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-4df0cf4-20261105T051938Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 26（序号 406–431；431 用量未知并计入未知预留） |
| 累计 | 431/650，剩余 219 |
| 本批已知增量 | 0.9703763399999978 美元 |
| 本批未知预留增量 | 0.4718592 美元 |
| 已知用量估算 | 5.642562287999997 美元 |
| 未知预留 | 2.359296 美元 |
| 保护占额 | 8.001858287999998 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 阶段截图 | phase-0 .. phase-3 browser.png（共 4 次 applied） |
| 停止原因 | **model-time-window-exhausted**：诊断「本阶段已用完模型时间窗口，保留后续候选与验收时间并停止」。不是 meter-exhaust，也不是 20 美元费用护栏。 |

相对 afde277：当时 9 次调用后在 planning-gate / plan-compilation 因「既有字段的宿主派生义务无法重新绑定」硬停。本轮该致命短语未再出现于 events/failure；多插件 applied 路径推进到 phase-3，说明 e655fee/1dae482 宿主派生重绑定路径已被真实模型行使且未复现该门禁失败。完整六步仍未完成。

旧 `real/targeted`、`real/chains`、`real/bounded-probe-afde277-20261105T020119Z`、`real/bounded-probe-b7e9965-20261105T035722Z` 未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-4df0cf4-outcome.json`。供应商账单未知。没有生产部署。

### 下一步阻塞

完整六步通过数仍为 0。调用天花板 650 仍剩余 219 次，费用护栏仍有余量。当前阻塞是验收阶段的 **模型时间窗口**（stage model time window），而非调用天花板或 20 美元护栏。若继续付费六步，需要放宽/调整该阶段时间窗或拆分策略，而不是再抬调用天花板。Routine `todo-by-cordis` 保持启用（完整六步仍未通过）。

## 2026-11-05 Mac round-2 延长时间窗付费探针（5ce3a43）

观察时间：2026-11-05 07:11–07:18Z（Asia/Shanghai 15:11–15:18）。分支 tip `5ce3a43c0b480497bd52ba76bca06c65999f40e8`（= origin）。本机 `zangtaodeMacBook-Pro.local`。用户 t51u 授权付费验证且合理调用不设限；费用护栏仍约 20 美元。本轮在 round-1 时间窗停止之后，用探针本地 `v1-scenario-extended-ms`（1.8e6 ms + milliseconds pause grants）再跑单条六步。

### CI 门禁

Push [41976774686](https://github.com/tower1229/todo-by-cordis/actions/runs/41976774686) 与 PR [41976781355](https://github.com/tower1229/todo-by-cordis/actions/runs/41976781355) 均 success（应用 866/866，E2E 111；push 完成 07:07:21Z，PR 完成 06:50:19Z）。付费前刷新了事故观察（Resolved，`incident-visible-20261105T0711Z.txt`）。

### 账本

探针开始前累计 **431/650**，剩余 219。已知用量估算起点 5.642562287999997 美元，未知预留 2.359296 美元，保护占额起点 8.001858287999998 美元。缺席台账继承 309–394；afde277 395–403、b7e9965 404–405、4df0cf4 406–431 证据保留未覆盖。绑定：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-5ce3a43-bind.json`。

### 探针结果

有界真实路径：单次探针本地 extended-ms `runV1Acceptance`（产品 `scripts/lib/v1-scenario.ts` 未改），Node v24.18.0。未跑双六步 / accept:v1 / stock runner。未启动序号 442 的下一轮付费。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-5ce3a43-20261105T071122Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 10（序号 432–441，用量均已知） |
| 累计 | 441/650，剩余 209 |
| 本批已知增量 | 0.17931406799999916 美元 |
| 已知用量估算 | 5.821876355999996 美元 |
| 未知预留 | 2.359296 美元 |
| 保护占额 | 8.181172355999996 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 阶段截图 | phase-0-browser.png（phase-0 applied 1 次；phase-1 失败） |
| 停止原因 | **business-revision-missing-existing-requirement**：诊断「业务修订引用的既有要求不存在」。不是 meter-exhaust，也不是 20 美元费用护栏，也不是 round-1 的模型时间窗口。 |

相对 round-1（4df0cf4）：延长时间窗后未再撞 stage model time window；phase-0 已应用。相对 afde277：未复现「既有字段的宿主派生义务无法重新绑定」。本轮新阻塞是 phase-1 业务修订引用缺失既有要求（复核另有 blank-tag / done-increment error-feedback 的 extra-constraint/conflict 未关闭 findings）。

旧 `real/targeted`、`real/chains`、`real/bounded-probe-afde277-20261105T020119Z`、`real/bounded-probe-b7e9965-20261105T035722Z`、`real/bounded-probe-4df0cf4-20261105T051938Z` 未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-5ce3a43-outcome.json`。供应商账单未知。没有生产部署。

### 下一步阻塞

完整六步通过数仍为 0。调用天花板 650 仍剩余 209 次，费用护栏仍有余量。当前阻塞是 **业务修订引用的既有要求不存在**（phase-1 natural-flow fatal），不是调用天花板、费用护栏或模型时间窗口。本 docs 轮次不启动序号 442 付费；由 CloudAgent 走代码修复后再议续跑。

## 2026-11-05 Mac round-3 延长时间窗付费探针（6bacd68）

观察时间：2026-11-05 08:40–08:50Z（Asia/Shanghai 16:40–16:50）。分支 tip `6bacd68613e2dfc8da3d9dc07fb9aa07db9614a2`（= origin）。本机 `zangtaodeMacBook-Pro.local`。用户 t51u 授权付费验证且合理调用不设限；费用护栏仍约 20 美元。本轮在 6bacd68（缺失业务修订目标降级为新增要求）合入且双 CI 绿后，用探针本地 `v1-scenario-extended-ms`（1.8e6 ms + milliseconds pause grants）再跑单条六步，序号自 442 起。

### CI 门禁

Push [41987221871](https://github.com/tower1229/todo-by-cordis/actions/runs/41987221871) 与 PR [41987228498](https://github.com/tower1229/todo-by-cordis/actions/runs/41987228498) 均 success（应用 866/866，E2E 111；push 完成 08:39:49Z，PR 完成 08:32:43Z）。既有 wait-ci PID 3521 在双绿后一次性调用 `launch-round3-when-ci-green.sh`；未另开并行探针。付费前刷新了事故观察（Resolved，`incident-visible-20261105T0840Z.txt`；HTML 拉取失败时复用既有归档）。

### 账本

探针开始前累计 **441/650**，剩余 209。已知用量估算起点 5.821876355999996 美元，未知预留 2.359296 美元，保护占额起点 8.181172355999996 美元。缺席台账继承 309–394；afde277 395–403、b7e9965 404–405、4df0cf4 406–431、5ce3a43 432–441 证据保留未覆盖。绑定：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-6bacd68-bind.json`。

### 探针结果

有界真实路径：单次探针本地 extended-ms `runV1Acceptance`（产品 `scripts/lib/v1-scenario.ts` 未改），Node v24.18.0。未跑双六步 / accept:v1 / stock runner。未启动序号 455 的下一轮付费。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-6bacd68-20261105T084029Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 13（序号 442–454，用量均已知） |
| 累计 | 454/650，剩余 196 |
| 本批已知增量 | 0.24945720000000016 美元 |
| 已知用量估算 | 6.071333555999996 美元 |
| 未知预留 | 2.359296 美元 |
| 保护占额 | 8.430629555999996 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 阶段截图 | phase-0-browser.png、phase-1-browser.png（phase-0/1 各 applied 1 次；phase-2 失败） |
| 停止原因 | **planning-gate / plan-compilation**：诊断「历史准备无法由基础版本唯一推导：tag:tag」。`blockReason=maintainer-capability`。不是 meter-exhaust，不是 20 美元费用护栏，不是模型时间窗口，也不是 round-2 的「既有要求不存在」。 |

相对 round-2（5ce3a43）：6bacd68 降级修复后 **未复现**「业务修订引用的既有要求不存在」；phase-0 与 phase-1 均已应用。相对 round-1（4df0cf4）：延长时间窗下未再撞 stage model time window。相对 afde277：未复现宿主派生重绑定致命。本轮新阻塞与更早 `chains-history`（`tags:tags`）/ `real/chains`（`counter:count`）同类：**历史准备不唯一（tag:tag）**，停在 phase-2 规划编译门禁。

旧 `real/targeted`、`real/chains`、`real/bounded-probe-afde277-20261105T020119Z`、`real/bounded-probe-b7e9965-20261105T035722Z`、`real/bounded-probe-4df0cf4-20261105T051938Z`、`real/bounded-probe-5ce3a43-20261105T071122Z` 未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-6bacd68-outcome.json`。供应商账单未知。没有生产部署。

### 下一步阻塞

完整六步通过数仍为 0。调用天花板 650 仍剩余 196 次，费用护栏仍有余量。当前阻塞是 **历史准备无法由基础版本唯一推导：tag:tag**（phase-2 planning-gate / plan-compilation / maintainer-capability），不是调用天花板、费用护栏、模型时间窗口或 round-2 缺失既有要求。本 docs 轮次不启动序号 455 付费；需代码/基线侧处理 tag 字段历史唯一性后再议续跑。

## 2026-11-05 Mac round-4 延长时间窗付费探针（8b18866）

观察时间：2026-11-05 10:13–10:26Z（Asia/Shanghai 18:13–18:26）。分支 tip `8b18866c417175f401788fe68064f5112990fea2`（= origin）。本机 `zangtaodeMacBook-Pro.local`。用户 t51u 授权付费验证且合理调用不设限；费用护栏仍约 20 美元。本轮在 8b18866（多历史最短路径降级）合入且双 CI 绿后，用探针本地 `v1-scenario-extended-ms`（1.8e6 ms + milliseconds pause grants）再跑单条六步，序号自 455 起。

### CI 门禁

Push [41998576331](https://github.com/tower1229/todo-by-cordis/actions/runs/41998576331) 与 PR [41998583566](https://github.com/tower1229/todo-by-cordis/actions/runs/41998583566) 均 success（应用 866/866，E2E 111；push 完成 10:12:19Z，PR 完成 09:57:54Z）。既有 wait-ci PID 21127 在双绿后一次性调用 `launch-round4-when-ci-green.sh`；未另开并行探针。付费前刷新了事故观察（Resolved，`incident-visible-20261105T1013Z.txt`）。

### 账本

探针开始前累计 **454/650**，剩余 196。已知用量估算起点 6.071333555999996 美元，未知预留 2.359296 美元，保护占额起点 8.430629555999996 美元。缺席台账继承 309–394；afde277 395–403、b7e9965 404–405、4df0cf4 406–431、5ce3a43 432–441、6bacd68 442–454 证据保留未覆盖。绑定：`.runtime/continuous-revision-study-20261104-r11/bounded-probe-8b18866-bind.json`（boundAt 2026-11-05T10:13:04.751176+00:00）。

### 探针结果

有界真实路径：单次探针本地 extended-ms `runV1Acceptance`（产品 `scripts/lib/v1-scenario.ts` 未改），Node v24.18.0，PID 38053。未跑双六步 / accept:v1 / stock runner。未启动序号 468 的下一轮付费。

| 项 | 值 |
| --- | --- |
| 证据目录 | `.runtime/continuous-revision-study-20261104-r11/real/bounded-probe-8b18866-20261105T101315Z` |
| 通过 | 否 |
| 完整六步通过 | 否（仍为 0） |
| 新调用 | 13（序号 455–467，用量均已知） |
| 累计 | 467/650，剩余 183 |
| 本批已知增量 | 0.3301473479999997 美元 |
| 已知用量估算 | 6.401480903999996 美元 |
| 未知预留 | 2.359296 美元 |
| 保护占额 | 8.760776903999997 美元（仍低于 20） |
| 实际模型 | deepseek-flash |
| 阶段截图 | phase-0-browser.png、phase-1-browser.png、phase-2-browser.png（phase-0/1/2 各 applied 1 次；phase-3 失败） |
| 停止原因 | **planning-gate / plan-compilation**：诊断「浏览器验收案例超出上限：34 条，最多 30 条」。`blockReason=other`。不是 meter-exhaust，不是 20 美元费用护栏，不是模型时间窗口，也不是 round-3 的 tag:tag 历史不唯一，也不是 round-2 的「既有要求不存在」。 |

相对 round-3（6bacd68）：8b18866 最短路径降级后 **未复现**「历史准备无法由基础版本唯一推导：tag:tag」；phase-0/1/2 均已应用。相对 round-2（5ce3a43）：**未复现**「业务修订引用的既有要求不存在」。相对 round-1（4df0cf4）：延长时间窗下未再撞 stage model time window。本轮新阻塞是 phase-3 规划编译时 **浏览器验收案例 34>30**（硬上限见 `src/server/requirement-coverage.ts`）。

旧 `real/targeted`、`real/chains`、`real/bounded-probe-afde277-20261105T020119Z`、`real/bounded-probe-b7e9965-20261105T035722Z`、`real/bounded-probe-4df0cf4-20261105T051938Z`、`real/bounded-probe-5ce3a43-20261105T071122Z`、`real/bounded-probe-6bacd68-20261105T084029Z` 未重置、未覆盖。结果 JSON：`docs/reports/r11-20261104/bounded-probe-8b18866-outcome.json`。供应商账单未知。没有生产部署。

### 下一步阻塞

完整六步通过数仍为 0。调用天花板 650 仍剩余 183 次，费用护栏仍有余量。当前阻塞是 **浏览器验收案例超出上限：34 条，最多 30 条**（phase-3 planning-gate / plan-compilation），不是调用天花板、费用护栏、模型时间窗口、tag:tag 历史不唯一或缺失既有要求。本 docs 轮次不启动序号 468 付费；需处理 browserCases 累计上限（合并/裁剪继承案例，或上调硬上限并配套测试）后再议续跑。

