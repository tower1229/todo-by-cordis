# 模型接口收缩与连续迭代验证交接

交接日期：2026-11-04。仓库：`/Users/zangtao/Workspace/tower1229/todo-by-cordis`。

## 当前状态：已暂停，尚未完成

用户已经暂停持续目标“按建议顺序推进，授权过程中必要的调用次数和费用”，随后仅要求保存交接文档。目标工具确认状态为 `paused`。本次只保存文档；后续会话须等待用户明确恢复，再继续实现、CI 或付费验证。此前资源授权仍有记录，但不覆盖当前暂停。

最后已提交、已推送的源码为 `608280eb46e096b6539040146e046c374b35bc7a`，分支 `codex/model-interface-contraction`。工作区还有三份**未提交修复**，已有本地验证，尚无对应完整 CI 或真实模型结果。交接文档本身也未提交。不要覆盖这些改动，也不要把 `608280e` 的通过结果用于当前工作区。

本轮已启动的真实阶段和本地验证均已结束；没有等待中的真实模型请求。完整真实六步链通过数仍为 **0**，四个真实策略对照臂尚未启动。没有生产部署或用户产品验收结论。

## 目标与已有架构结论

原始讨论：[用户分享会话](https://chatgpt.com/share/6ae7e8fb-4b6c-83e8-b39a-ca687e63b0d6)。用户先要求只读方案，后续持续目标授权了必要实现、验证和费用；当前暂停优先。

架构与历史结果直接阅读现有材料，不重写规格：

- [领域语义](../CONTEXT.md)、[独立保护约束 ADR](adr/0002-protect-independent-evolution-controls.md)、[需求冻结 ADR](adr/0004-freeze-request-and-show-execution-progress.md)。
- [Agent 当前设计](engineering/06-agent-redesign.md)，特别是文档前部的接口收缩与字段投影说明。
- [核心方向与逐轮证据](engineering/00-core-direction-v2.md)，第 10.19–10.26 节记录已有修复；本轮最新的派生来源修复**尚未补入这些设计文档**。

已实现六项规划工具，普通路径为业务规划、独立复核、候选生成，必要时保留条件准入。宿主负责机械引用和验收编译；来源绑定、显式业务修订、独立复核、冻结、系统保护、真实浏览器、隔离体验、精确应用与恢复继续保留。历史 B/C 单对已重核：两者均为 high、源码不同，调用下降没有伴随该对的时间、token、费用下降，不能用于因果提效或 max/high 结论。

DSH 源码参考固定到 `8bd073392eef6f54e921a093b95076248eb08cbb`；两个只读工具是 `tool-cordis` 包的工具，不是整个 Harness 的全部工具。固定源码、接口审计和历史 B/C 归因见本机 r9/r10 证据目录。当前没有第二业务接入或跨业务维护成本改善的实测结论。

## 本轮真实结果与资源台账

`608280e` 的 [CI 41777935603](https://github.com/tower1229/todo-by-cordis/actions/runs/41777935603) 完整通过：应用测试 **849/849**、E2E **111/111**、类型检查和构建。原始日志、元数据及门禁保存在本机 r10。此前 52 次 SDK/原生/Chromium 零付费预演和请求正文凭证扫描通过；1141 份原预演材料、补充审计器材料及最终 1191 份付费前材料分别封存。

| 阶段 | 实际结果 | 证据边界 |
| --- | --- | --- |
| 当前提交真实定向，第 277–280 次 | 4 次已知用量、1 候选、约 216.914 秒原生活动时间；独立后端 7 项、浏览器 4 个定义/12 次运行、体验、精确应用、旧数据、重启及恢复通过 | 130 份通过证据封存；首份提案含未授权 `id`，原生协议纠错后通过，不算首轮成功 |
| 第一条链新增标签，第 281–284 次 | 4 次调用、1 候选，完整路径通过 | 第 284 次等待较长但最终正常返回，真实耗时保留 |
| 第一条链新增计数，第 285–287 次 | 3 次调用、1 候选，完整路径通过 | 独立复核无业务问题 |
| 第一条链小写升级，第 288–292 次 | 5 次已知用量、0 候选，以 `phase-time-reserve` 暂停 | 活动消耗约 381.364 秒，仍剩约 218.636 秒、7 次调用和 3 个候选额度；不是调用耗尽或十分钟全用完 |
| 后续 | 第一条链第 4–6 步、第二条链、四个策略臂均未开始 | 完整六步链仍为 0 |

本轮新增真实调用 **16**，全部有用量。累计占用 **292/405**，共享剩余 **113**。持续目标第 186–292 次共 **107** 次，105 次用量已知，202/250 两次未知。按共同峰值价估算的已知目标费用为 **$2.225884056**，未知用量预留 **$0.9437184**，费用保护占额 **$3.169602456**；实际供应商账单未知。峰值估算价：缓存输入 $0.006、未缓存输入 $0.3、输出 $1.2/百万 token；思考 token 已包含在输出中。

405 次及 $20 是广泛资源授权下选择的执行上限，不能称为用户逐项指定。每个原生变更仍为 12 次调用、3 候选、600000ms，零追加、零外层重试；生产默认 max，实验隔离注入 high。用户确认第 250 次断流时有代理操作且后来恢复，具体操作及唯一故障原因未知；该次用量继续未知。

**须纠正一处已发现的分析文案错误。** r9/r10 的部分失败说明把下一规划所需活动时间写为 256000ms。刚读到 [BudgetScheduler](../src/evolution/budget.ts) 后发现：在 600000ms 限额下，规划的后续预留为 225000ms，最小模型窗口为 10000ms，按代码公式应为 **235000ms**。暂停回执另有 `minimum.milliseconds=128000`，其字段语义尚未复核，不要混作 `modelWindow` 准入阈值。此更正尚未做可执行边界验证或追加审计；暂停前没有改写任何封存文件。恢复后先调用原 `BudgetScheduler.modelWindow` 验证 234999/235000 边界，再新增更正记录，保留旧错误说明及其封存哈希。旧运行仍确实不足以启动下一规划，失败结论不变。

## 最新未提交修复

涉及三份文件，具体实现以 `git diff` 为准，交接时为 127 行新增、16 行删除：

- [obligation-derivation.ts](../src/evolution/obligation-derivation.ts)：从规范字段复制出的隐式投影补上现有 `derivation` 来源，避免副本被误作新的独立业务权威。
- [references.ts](../src/evolution/references.ts)：继承重编译只使用本次明确输入形成的固定定义集合，避免刚生成的投影再次成为竞争定义；唯一宿主绑定下沿用旧无作用域身份；共享私有 `reuseFieldIdentity`，按完整相同操作路径保留案例身份、历史及保护。
- [inherited-field-projection.test.ts](../tests/app/inherited-field-projection.test.ts)：新增 8 项回归，该文件当前 22 项。

原始失败链定位到：第 285 次增加计数时，宿主把原标签字段定义复制给计数及保留要求，却丢失了“宿主派生”标记。后续标签升级只修订原标签所有者时，这些副本仍保留 `Todo List`，复核正确指出冲突。多副本重放又暴露循环把新副本纳入规范定义，以及旧无作用域身份与新绑定身份重复的问题。修复没有增加模型字段、工具、轮次、预算或通用规格层，也没有根据关键词改业务值。

仍保留的拒绝：旧冻结副本没有派生来源时不猜测重分类；遗漏明确业务所有者的修订继续受阻；不同明确作用域、歧义、错误显式业务值和不可达前置不放行；缩短操作路径不能替代旧连续操作；缺少修订原因仍阻断；30 条浏览器案例上限不变。

## 已实际运行的本地验证

最新修复只有以下证据，**不是整套应用测试/E2E 或新 CI 全绿**：

- 9 个相关测试文件同批 **118/118**，零失败、取消、跳过，包含实际 Chromium 路径。会话 `28404` 已退出 0。
- `pnpm typecheck`、最终 `pnpm build`、新增测试文件的独立严格 TS7 类型检查均退出 0。
- 最先添加的 4 项回归在 `608280e` 上全部失败；随后补充多副本、身份和拒绝控制，当前字段专项 22/22。所有中间失败日志保留。
- 原第 285 次计数提案在恢复到标签版本的**复制工作区**中，经真实 `EvolutionDomain.parse` 编译通过，两个旧式副本现在带派生来源，任务数组保持不变。
- 用宿主重新编译的计数元数据组成**反事实编译基线**后，原第 291 次提案参数不改，编译无阻断、无旧大写动作后值；编译案例 21 条，显式继承后 23 条，两条连续保存断言经原因记录替换，完整动作、输入、刷新重启和系统保护逐项保留。此基线没有重新经过独立复核、冻结、生成或应用，不能称为原失败工作区直接修复成功，更不能称为真实模型成功。
- 原第 289 次遗漏明确业务修订的提案仍被拒绝。旧 r9 原第 275 次提案再次经实际 SDK 和原生协调器离线回放，到达独立复核请求后主动停止；0 候选，终态 blocked 是夹具停止，未提供复核响应。

复现工具版本：Node `24.18.0`，pnpm `12.3.4`。本机 Node 路径：

```sh
export PATH="$PWD/.runtime/scoped-tags-node2418/node-v24.18.0-darwin-arm64/bin:$PATH"
```

相关回归命令：

```sh
node --import tsx --test --test-concurrency=1 \
  tests/app/inherited-field-projection.test.ts \
  tests/app/planning-compiler.test.ts \
  tests/app/host-references.test.ts \
  tests/app/existing-field-revision.test.ts \
  tests/app/field-reference-rebind.test.ts \
  tests/app/browser-field-rebind.test.ts \
  tests/app/planning-requirement-revision.test.ts \
  tests/app/acceptance-obligations.test.ts \
  tests/app/obligation-normalization.test.ts
```

## 本机证据入口

以下材料处于 `.runtime` 忽略目录，**没有随 Git 推送**。跨设备交接须另行保留这些文件；缺失时不能补造通过或重建旧台账。不要打印完整 `failure.json`、`summary.fatal` 或原生快照，其中可能含数十万 token；用 `observe.py` 或仅取指定字段。

主目录：[r10](../.runtime/continuous-revision-study-20261104-r10/)。

| 文件/目录（相对 r10） | 用途 |
| --- | --- |
| `ci-gate.json`、`ci-run-final.json`、`ci-run-final.log` | 精确 `608280e` 完整 CI；不是当前未提交源码的 CI |
| `prepaid-validation-sha256.json` | 1191 份付费前材料；不可覆盖 |
| `real-targeted-pass-audit.json`、`real-targeted-pass-sha256.json` | 当前已提交版本真实定向通过，130 份封存 |
| `real-chains-failure-audit.json`、`real-chains-failure-sha256.json` | 12 次真实链调用及失败，97 份封存；阈值文案错误须追加更正，不覆盖 |
| `real-targeted-model-intervals.json`、`real-chains-model-intervals.json` | 原生精确请求关联；4 次 139450ms、12 次 786535ms；包含适配、完整性检查和传输，不是纯推理时间 |
| `revision-ownership-diagnosis/` | 本轮原始参数、复制工作区、所有红绿日志及阶段探针；目录尚未完成修复总审计和封存 |
| `revision-ownership-diagnosis/v4-staged-replay-summary.json` | 原参数阶段重放最终摘要；v1–v3 中间失败继续保留 |
| `revision-ownership-diagnosis/native-original275-repair/result.json` | 旧原第 275 次 SDK/协调器兼容控制，非完整成功 |
| `audit-targeted-v2.py`、`audit-real-study-v2.py`、`audit_output_policy.py` | r10 的有效只读审计器；v1 对条件准入额度判断有错，禁止继续用 v1 签发通过 |
| `auditor-amendment-sha256.json`、`target-auditor-policy-amendment.json` | 付费前审计器修正证据；admission=65536，其余三阶段=131072 |
| `architecture-cost-report-draft.md`、`.json`、`report-draft-evidence.json` | 可读阶段草稿，**不是最终报告**；部分状态仍停留在链运行中或第 276 次快照，须按真实台账更新 |
| `preparation-state.json` | r10 最近写入的是链失败/累计 292；未包含此后未提交修复与本次暂停，不能据此自动继续 |
| `authorization.json`、`analysis-plan.json`、`config.json`、`envelopes/v1.json` | 已关闭的 r10 原注册条件；不可原地换成新源码或重开运行 |

更早的通过、失败和修复证据见 r9 的封存清单及其 `field-revision-diagnosis/repair-validation-sha256.json`。闭合试验数据库只读；需要原生重放时复制到新诊断目录，不在旧数据库上运行 `Workspace.open`。当前所有诊断工作区均是副本。

## 用户恢复后的顺序

1. 重读当前 `AGENTS.md`、领域文件及相关 ADR，确认分支和三份源码差异仍在；核对本交接之后的新改动，避免覆盖用户工作。
2. 先补可执行的预算阈值更正，以及本轮修复总审计和封存。阶段探针是反事实编译基线，报告必须保留该限制；不要重新签发 r10 失败为通过。
3. 审阅当前小补丁是否还存在必要问题，更新设计文档（拟新增 10.27）和阶段报告。已有 118 项及类型/构建通过，无新修改或未决问题时不重复无意义测试。尚未跑当前源码完整应用套件、E2E 或对应 CI。
4. 恢复授权内完成必要提交和推送，核对干净工作区及上游同步，再取得**新提交**的完整 CI。基线 849 加本轮 8 项，应用测试预计 857；最终以实际 CI 日志为准，E2E 预计 111，不能先写通过。
5. 新建独立下一批目录，继承累计 292、全部历史台账、两次未知用量及费用，剩余共享 113。不要重开 r10 的 `real/targeted` 或 `real/chains`。新源码的通过门禁、基线和前端摘要必须重新冻结。
6. 重新完成 52 次零付费 SDK/原生/Chromium 全阶段预演、独立审计、正文凭证扫描、缺门禁负向控制和资源核对。新审计器应基于 v2 的分阶段额度契约；复制到新提交时更新身份和预期数量，重新验证，不能改旧封存文件。
7. 真实阶段开跑前刷新官方事故状态和原生代理路径，保存不可变观察及公开源码证据。r10 的 06:29 UTC 恢复观察已有时效，不能沿用。门禁缺失必须在密钥加载和试验目录创建前拒绝；HTTP 401 的无凭证路由探针只证明连通性，不证明长推理可靠或真实密钥有效。
8. 按原顺序完成：新源码真实定向完整路径 → 两条全新独立六步链 → 预注册 once-only `max/high/high/max` 四臂 → 完成审计与最终架构/费用报告。两条链均须完整通过；策略臂失败和未知照录，只有对应完整成功且用量已知的路径才计算效率比率，不择优重跑。

六步链内容、验收与确认流程直接沿用 [v1-scenario.ts](../scripts/lib/v1-scenario.ts)，不删阶段或换成单次定点。真实失败后先停止并封存，再原输入零付费诊断；只有已验证的具体修复或明确外部状态变化才构成下一付费批次依据。

下一会话建议继续使用 `/Users/zangtao/.agents/skills/diagnosing-bugs/SKILL.md` 做原输入诊断，以及 `/Users/zangtao/.agents/skills/codebase-design/SKILL.md` 检查宿主模块职责。本轮已阅读这些技能；`handoff` 仅用于此文档。当前没有用户授权的子 Agent 要求，不主动派发子 Agent。

终态报告必须区分：代码实现、本地回归、精确提交 CI、模型桩、真实定向、完整真实链、策略对照、费用估算与账单、源码交付与生产部署。当前目标是暂停而非完成。
