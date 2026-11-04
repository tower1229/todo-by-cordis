# 预算阈值更正

**日期**: 2026-11-04  
**交接批次**: r10 → r11  
**状态**: 已验证

## 问题

交接文档 `docs/handoff-2026-11-04-model-interface-contraction.md` 的第 10.26 节及失败说明中，将下一规划所需活动时间写为 **256000ms**。经核查 `src/evolution/budget.ts` 的 `BudgetScheduler.modelWindow` 实现，在 600000ms 限额下的实际阈值是 **235000ms**。

## 验证

在 600000ms 限额下：

```
verificationMilliseconds = floor((600000 * 0.075) / 1000) * 1000 = 45000ms
reserve(0.15) = floor((600000 * 0.15) / 1000) * 1000 = 90000ms
reserve(0.02) = floor((600000 * 0.02) / 1000) * 1000 = 12000ms

对于 planning 阶段：
after("planning") = verificationMilliseconds + reserve(0.15) + reserve(0.15)
                 = 45000 + 90000 + 90000 = 225000ms

最小窗口 = max(1, min(10000, reserve(0.02))) = 10000ms
阈值 = after("planning") + 最小窗口 = 225000 + 10000 = 235000ms
```

边界测试：
- `234999ms` 应该抛异常：`234999 - 225000 = 9999 < 10000` ✓
- `235000ms` 应该不抛异常：`235000 - 225000 = 10000 >= 10000` ✓

可执行验证已于 2026-11-04 在提交 `80e0487` 上完成，Node 24.18.0，退出码 0。

## 更正说明

r10 的 `phase-time-reserve` 暂停发生在剩余约 192.232 秒时。原失败说明中的"低于下一规划阶段的 256 秒预留要求"应理解为"低于下一规划阶段 **235 秒**（235000ms）预留要求"。该批次实际计算与阻断条件正确，终态 `awaiting-budget`、零候选的结论不变。

r10 的封存文件 `real-chains-failure-audit.json`、`real-chains-failure-sha256.json` 及其原文档说明中提到的 256000ms 或 256 秒保持原样不修改，本更正作为独立记录存档。

## 历史封存哈希（不可变）

r10 的以下封存文件维持原始记录：
- `real-chains-failure-audit.json`
- `real-chains-failure-sha256.json`
- `architecture-cost-report-draft.md`（草稿）
- 以及交接文档中提及的相关说明

这些文件中提到的 256000ms 或 256 秒仍反映当时的分析文案，本更正不追溯改写已封存证据。

## 后续影响

新批次 r11 的预算判断将引用正确的 **235000ms** 阈值。`BudgetScheduler.modelWindow` 的源码实现本身无误，无需修改。旧运行的失败结论（不足以启动下一规划）保持有效。

---

**封存身份**: 本文件作为 r10 修复总审计的一部分存档，不覆盖旧证据，仅补充更正记录。
