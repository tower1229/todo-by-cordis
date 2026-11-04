# r11 续跑停止报告

观察时间：2026-11-04 08:52Z。分支 `codex/model-interface-contraction`。本报告只记录已经发生的结果。

## r10 压缩包

四个分卷的 sha256 均与 `SHA256SUMS` 一致，已用 `cat r10-part0*.gz | tar -xzf - -C .runtime/` 解压。目录 `.runtime/continuous-revision-study-20261104-r10` 有 1707 个文件，被 `.gitignore` 忽略，没有进入 Git。检查后目录改为只读，`real/targeted` 和 `real/chains` 没有重开。

r10 封存的是提交 `608280e`、累计 292、剩余 113。v2 审计器 `audit-outbound-payload.mjs`、`audit-targeted-v2.py`、`audit-real-study-v2.py` 都在包内。包内没有 30 份更早付费台账、6580 个用户本机绝对路径依赖、两份基线 `workspace.db`，也没有 `.env`。这两份数据库的冻结哈希分别是 `76b1da827ae853280f15f610c0a8c4a05bfedad17a00f73a7dc507d376bfc08d` 和 `93fa8ce2921a1b36cb298b0598114fa6619cec0d61b3295516f980ef0fceed4b`。没有按哈希补造文件。

## 分类结果

| 类别 | 结果 |
| --- | --- |
| 代码实现 | 字段投影修复在 `80e0487`。`54b1ba3` 只增加预算阈值更正和 10.27。本轮新增门禁脚本与 r11 记录，没有再改演化实现 |
| 本地回归 | 交接中的 118/118 日志不在这四卷里。本机已安装 Node v24.18.0，并完成本地 build；没有重跑 857 项应用测试 |
| 精确提交 CI | `54b1ba3` 的 [41793691114](https://github.com/tower1229/todo-by-cordis/actions/runs/41793691114) 成功：应用 857/857，失败、取消、跳过均为 0；E2E 111/111；typecheck 与 build 已完成。`80e0487` 的 [41792902839](https://github.com/tower1229/todo-by-cordis/actions/runs/41792902839) 在 08:41Z 仍停在 E2E，没有终态 |
| 模型桩 | 新源码 52/52 零付费预演通过，见下文。这是桩与原生路径，不是真实模型通过 |
| 真实定向 | 未启动。密钥未读取，试验目录未创建 |
| 完整真实链 | 历史完整通过数仍为 0；本批未启动 |
| 策略对照 | 四个臂只有零付费桩的完整路径。真实策略对照未启动 |
| 费用估算与账单 | 沿用交接数字，没有逐次台账文件。已知用量估算 2.225884056 美元，未知预留 0.9437184 美元，保护占额 3.169602456 美元。本批新增调用 0。供应商账单未知 |
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

六步链脚本 `scripts/lib/v1-scenario.ts` 仍在仓库中。真实链要等密钥消息、一小时内的事故观察和该提交自己的 CI 终态后再按原顺序启动，一次失败即停止封存。这次文档提交的 CI 还没有终态，不能记为通过。
