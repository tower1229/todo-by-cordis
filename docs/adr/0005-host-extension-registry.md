---
status: accepted
---

# 宿主扩展注册表与在线调度地基

2026-09-08，维护者确认先补齐扩展钩子表面，再谈到期提醒等业务能力。自迭代 Agent 仍不能修改本约束；业务插件通过可选 `contribute` 与约定方法参与，不得直接访问数据库。

宿主在版本激活时采集 `contribute()`（缺省为空），装入 `ExtensionRegistry`，并按声明调用 lifecycle：`activate → ready`；切换或关闭前 `quiesce → dispose`。`task.beforeCommit` 在 `decide` 得到 commit 之后、写库之前串行调用；`task.created|updated|deleted` 在提交成功后派发，观察者失败只记诊断、不回滚。`schedule.register` 仅支持当前进程在线武装（绝对时间 + `skip`/`run-once`），触发已注册 action command；不承诺系统推送或关页后可靠提醒。

架构目录中的其余扩展点（`ui.slot`、`query.filter|sort`、`diagnostics.annotate`、除 workflow 外的 `service.provide`）可登记并出现在 `composition.extensions` 能力摘要中，状态为 `stub` 或 `declared`，本阶段不改变查询 SQL 或前端插槽渲染。不恢复 V1 capability broker / 容器市场。`workflow/1` 验收继续有效；存在非空扩展贡献时标记 `extensions/1`。
