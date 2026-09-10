---
status: accepted
---

# 宿主扩展注册表与在线调度地基

2026-09-08，维护者确认先补齐扩展钩子表面，再谈到期提醒等业务能力。自迭代 Agent 仍不能修改本约束；业务插件通过可选 `contribute` 与约定方法参与，不得直接访问数据库。

宿主在版本激活时采集 `contribute()`（缺省为空），装入 `ExtensionRegistry`，并按声明调用 lifecycle：`activate → ready`；切换或关闭前 `quiesce → dispose`。`task.beforeCommit` 在 `decide` 得到 commit 之后、写库之前串行调用；`task.created|updated|deleted` 在提交成功后派发，观察者失败只记诊断、不回滚。`schedule.register` 仅支持当前进程在线武装：`atKind` 为 `absolute`（ISO）或 `field`（任务字段值）；可选 IANA `timezone` 解释无 offset 的墙钟时间；错过策略为 `skip`/`run-once`；触发已注册 action command。不承诺系统推送或关页后可靠提醒。

`composition.workflow.fields/actions` 为 describe 与 contribute 的合并视图（撞名字段安装失败；扩展 command 缺省 `from:["open"]`）；`retainedFields` 含当前扩展字段。钩子可返回 `annotations`，在声明 `diagnostics` 时由宿主限长收录，不覆盖 version/trace。

活动组合可含多个 `members`（稳定 `pluginId`、精确 `versionId`、`enabled`）；缺省或旧单插件版本视为单元素组合。同一业务 Runtime 子进程按 pluginId 装载多个模块；宿主对每个已启用成员分别采集 `contribute()`，合并字段与命令并标注 `providerId`。重复身份、双主工作流、双主排序及跨插件字段/命令撞名在激活前失败，正式组合与数据不变。辅助插件不必提供工作流；组合内有且仅有一个主工作流提供者。组合成员启用状态经两条正式路径变更，共用同一记版与数据保留约束：日常 Workspace 公开入口为 `setMemberEnabled` → 新组合修订 → publish；自迭代路径为 `recordMemberEnabledVersion`（与公开路径同记版约束）→ 既有 `experience`/`apply` 精确绑定 → `activate`/publish。普通自迭代不得借此修改 Evolution 执行策略或发布/验证/恢复等系统保护约束。类型化字段与查询 UI 仍属后续事项。

## UI 贡献（2026-09-09）

宿主白名单槽位目前仅 `task.detail`。`HOST_UI_SLOTS` 即「宿主已实现该槽位渲染与动作分派」的门闩，须与前端任务详情渲染契约同步维护。插件经 `contribute().uiSlots` 登记可序列化 **UI 贡献**，形状为 `{ slot, id, title, body?, actions:[{ commandId, label }], fields?:[{ key, label }], order? }`；同槽多条按 `order`（缺省 0）再 `id` 稳定排序。宿主在组合摘要中暴露已解析的 `composition.uiContributions`，以及对声称 `task.detail` 但校验失败的 `composition.uiContributionFaults`（替代态）；未知 slot 仅跳过、不上屏。打开任务详情时用当前 `task` 绑定只读字段值，动作经既有 command / revision 路径写入，不新开平行写入口。非法贡献或 command 失败不得拖垮受保护外壳（停止自迭代、应用确认、恢复）。

`ui.slot` 能力状态：白名单槽位存在至少一条合法贡献时为 `active`；无贡献为 `declared`；仅有非白名单或非法登记时为 `stub`。`business/view.ts` 只服务候选体验摘要 `{title,fields}`，不作为任务页 UI 贡献源。

隔离体验（grilling Decision 7）：解析与任务页同一套 `uiContributions` 描述，并在隔离 Runtime 内对贡献动作执行一次 `decide` 模拟写入；结果标注尚未应用到正式环境。本期体验仅采集主工作流成员的 `contribute()`，不装载完整预览工作区或与任务页同构的可写会话。多成员辅助插件的 UI 贡献体验采集留待后续。

架构目录中其余扩展点（`query.filter|sort`、除 workflow 外的 `service.provide`）可登记并出现在 `composition.extensions` 能力摘要中，状态为 `stub` 或 `declared`，本阶段不改变查询 SQL。不恢复 V1 capability broker / 容器市场。`workflow/1` 验收继续有效；存在非空扩展贡献时标记 `extensions/1`。生成侧 `business/contract.ts`（evolution `contract` 字符串）须包含可选 `contribute` 与钩子方法签名。真实 Runtime 子进程须能反射并调用这些方法。自迭代 Agent 仍不能修改本类宿主约束。
