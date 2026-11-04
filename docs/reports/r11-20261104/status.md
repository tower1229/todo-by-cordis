# r11 续跑停止报告

观察时间：2026-11-04 08:41Z。分支 `codex/model-interface-contraction`。本报告只记录已经发生的结果。

## 分类结果

| 类别 | 结果 |
| --- | --- |
| 代码实现 | 字段投影修复在 `80e0487`。`54b1ba3` 只增加预算阈值更正和 10.27。本轮新增门禁脚本与 r11 记录，没有再改演化实现 |
| 本地回归 | 交接中的 118/118 日志在用户本机 `.runtime`，云端没有。本机 Node 是 v22.23.4，仓库要求 24.18.x，本轮没有在错误版本上重跑套件 |
| 精确提交 CI | `54b1ba3` 的 [41793691114](https://github.com/tower1229/todo-by-cordis/actions/runs/41793691114) 成功：应用 857/857，失败、取消、跳过均为 0；E2E 111/111；typecheck 与 build 已完成。`80e0487` 的 [41792902839](https://github.com/tower1229/todo-by-cordis/actions/runs/41792902839) 在 08:41Z 仍停在 E2E，没有终态 |
| 模型桩 | 0/52。r10 的 v2 审计器和预演材料不在本环境 |
| 真实定向 | 未启动 |
| 完整真实链 | 历史完整通过数仍为 0；本批未启动 |
| 策略对照 | 四个臂未启动 |
| 费用估算与账单 | 沿用交接数字，没有逐次台账文件。已知用量估算 2.225884056 美元，未知预留 0.9437184 美元，保护占额 3.169602456 美元。本批新增调用 0。供应商账单未知 |
| 源码交付与生产部署 | 源码已在分支上。没有生产部署，也没有用户产品验收 |

## 预算更正

`BudgetScheduler.modelWindow` 在 600000ms 限额下，planning 的准入阈值是 235000ms。旧分析文案中的 256000ms 保留为历史说明，r10 封存文件没有被改写。阶段探针仍是反事实编译基线。

## 台账缺口

`.runtime/continuous-revision-study-20261104-r10/` 不在云端，也没有随 Git 推送。累计 292、剩余 113、第 202 与 250 次未知用量，只引用交接文档，不重建旧哈希。r10 的 `real/targeted` 和 `real/chains` 没有重开。

## 付费前停止

2026-11-04 08:41:30Z 读取 https://status.deepseek.com/ 。页首为全部系统正常。内嵌最近事故 7202016104287 为 resolved，Flash API 组件记录为 operational，区间约 2026-11-03 08:58:16Z 至 10:41:12Z。状态 JSON API 返回 404。本环境没有代理变量。这次观察不证明长推理或密钥有效。

`node scripts/r11-real-phase-gate.mjs docs/reports/r11-20261104` 退出码 2。脚本没有读取 `DEEPSEEK_API_KEY`，也没有创建 `real/targeted` 或 `real/chains`。缺的门禁是 r10 封存、v2 审计器和 `prepaid-rehearsal-audit.json`。

六步链脚本 `scripts/lib/v1-scenario.ts` 仍在仓库中。真实链要等门禁材料齐备后再按原顺序启动，一次失败即停止封存。
