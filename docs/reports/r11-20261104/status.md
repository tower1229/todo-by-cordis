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
| 模型桩 | 0/52。r10 里已有上一批预演，新源码的 52 次没有开始：定点升级和四个策略臂依赖缺失的两份基线数据库 |
| 真实定向 | 未启动。密钥未加载 |
| 完整真实链 | 历史完整通过数仍为 0；本批未启动 |
| 策略对照 | 四个臂未启动 |
| 费用估算与账单 | 沿用交接数字，没有逐次台账文件。已知用量估算 2.225884056 美元，未知预留 0.9437184 美元，保护占额 3.169602456 美元。本批新增调用 0。供应商账单未知 |
| 源码交付与生产部署 | 源码已在分支上。没有生产部署，也没有用户产品验收 |

## 预算更正

`BudgetScheduler.modelWindow` 在 600000ms 限额下，planning 的准入阈值是 235000ms。旧分析文案中的 256000ms 保留为历史说明，r10 封存文件没有被改写。阶段探针仍是反事实编译基线。

## 台账缺口

r10 目录现在在云端且只读。它记录累计 292、剩余 113、第 202 与 250 次未知用量。更早的 30 份逐次台账文件不在这四卷里，没有重建。r10 的 `real/targeted` 和 `real/chains` 没有重开。

## 付费前停止

2026-11-04 08:52:16Z 重新下载 https://status.deepseek.com/incidents/7202016104287 。可见文本为 Resolved，最近更新 2026-11-03 10:48:00Z。08:52:45Z 的原生路由是 direct，无凭证 GET `/models` 返回 HTTP 401，耗时 333ms，没有加载环境文件，付费调用为 0。这只证明连通。本环境没有 `DEEPSEEK_API_KEY`。

Node v24.18.0 本地构建的三个前端文件与 CI 资源名一致，sha256 在 `fresh-readiness.json`。r10 冻结的 79 个历史前端文件没有被拿来给这次构建补签。

`node scripts/r11-real-phase-gate.mjs docs/reports/r11-20261104` 退出码 2。脚本没有读取密钥，也没有创建 `real/targeted` 或 `real/chains`。缺的是两份基线 `workspace.db` 和新的 `prepaid-rehearsal-audit.json`。

六步链脚本 `scripts/lib/v1-scenario.ts` 仍在仓库中。真实链要等门禁材料齐备后再按原顺序启动，一次失败即停止封存。
