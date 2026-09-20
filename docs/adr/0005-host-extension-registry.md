---
status: accepted
---

# 宿主扩展注册表与在线调度地基

2026-09-08，维护者确认先补齐扩展钩子表面，再谈到期提醒等业务能力。自迭代 Agent 仍不能修改本约束；业务插件通过可选 `contribute` 与约定方法参与，不得直接访问数据库。

宿主在版本激活时采集 `contribute()`（缺省为空），装入 `ExtensionRegistry`，并按声明调用 lifecycle：`activate → ready`；切换或关闭前 `quiesce → dispose`。`task.beforeCommit` 在 `decide` 得到 commit 之后、写库之前串行调用；`task.created|updated|deleted` 在提交成功后派发，观察者失败只记诊断、不回滚。`schedule.register` 仅支持当前进程在线武装：`atKind` 为 `absolute`（ISO）或 `field`（任务字段值）；可选 IANA `timezone` 解释无 offset 的墙钟时间；错过策略为 `skip`/`run-once`；触发已注册 action command。不承诺系统推送或关页后可靠提醒。

`composition.workflow.fields/actions` 为 describe 与 contribute 的合并视图（撞名字段安装失败；扩展 command 缺省 `from:["open"]`）；`retainedFields` 含当前 live 扩展字段，以及曾启用 contribute 后经宿主 `retainedExtensionFields` 记忆、停用后仍需保留展示/导出的字段定义。钩子可返回 `annotations`，在声明 `diagnostics` 时由宿主限长收录，不覆盖 version/trace。

活动组合可含多个 `members`（稳定 `pluginId`、精确 `versionId`、`enabled`）；缺省或旧单插件版本视为单元素组合。同一业务 Runtime 子进程按 pluginId 装载多个模块；宿主对每个已启用成员分别采集 `contribute()`，合并字段与命令并标注 `providerId`。重复身份、双主工作流、双主排序及跨插件字段/命令撞名在激活前失败，正式组合与数据不变。辅助插件不必提供工作流；组合内有且仅有一个主工作流提供者。组合成员启用状态经两条正式路径变更，共用校验、前进记版、publish/apply 与数据保留约束：日常 Workspace 公开入口为 `setMemberEnabled` → 新组合修订 → publish；自迭代路径为 `recordMemberEnabledVersion` → 既有 `experience`/`apply` 精确绑定 → `activate`/publish。已是目标启用状态时分流：`setMemberEnabled` 返回无变更幂等回执且不产生新修订；`recordMemberEnabledVersion` 必须实际翻转 `enabled`，否则拒绝（记版层不允许无意义候选）。普通自迭代候选记版须基于基础组合显式写出完整 `members`（未改成员继承精确 `versionId`、`enabled`、`role`）；`Release.record` 不隐式从父版本拼成员；该路径与启用态记版共存，且不得丢掉辅助成员。计划可用可选 `memberAdditions:[{pluginId,name}]`（本阶段最多一项）声明叠加新辅助成员；也可用可选 `memberUpgrades:[{pluginId}]`（本阶段最多一项）声明就地升级已有辅助成员；二者互斥。执行侧经 `submit_candidate.members` 提交对应源码，宿主先以 `passed:false` 记草稿辅助版本做组合验证，仅在候选总验收通过后再记 `passed:true` 的辅助版本并写入正式候选 `members`（升级替换该成员 `versionId`，新增则追加；未改成员继承精确 `versionId`/`enabled`/`role`）。仅升级辅助且工作流源码与字段契约相对 base 未变时，主工作流成员保留精确 `versionId`（pin 到 base），载体 Version 仍新建；随后以修改主工作流为目标的候选必须解 pin，把工作流成员绑到新载体实现，并继续精确保留未改辅助成员。自迭代提交的辅助成员须经与主候选同源的可信构建（`checkBusinessImports` + 记版 `bundle.outputs`），Runtime 走受限模块加载；`evidence.generated`（或兼容的 `origin: evolution-*`）成员禁止无 modules 的原生 import；缺 bundle 的旧版可在加载时合成 modules 并同 id 回写。调查阶段可读 `member-source|member-contract|member-acceptance/{pluginId}@{versionId}`；生成阶段经 `read_member` 按精确版本读取源码、契约与验收引用。辅助成员业务要求可通过可选 `memberCases` 冻结，由隔离 Workspace 检查器（`workspace/1`）解释；冒烟不是唯一通过条件，省略时从 `active-acceptance` 继承。验收探针可为执行冻结案例临时启用停用成员，正式组合不变。能力摘要中，宿主可为 `enabled=false` 的成员合成 `member.register`（`declared`）条目，表明仍登记于组合但未贡献；该 interfaceId 非插件自声明扩展点，真实启用态以 `members[].enabled` 为准。普通自迭代不得借此修改 Evolution 执行策略或发布/验证/恢复等系统保护约束。类型化字段与查询 UI 仍属后续事项。

能力声明按提供者绑定：辅助成员使用 `provider: member:<pluginId>`，`capability` 使用宿主实际可执行的接口名（如 `command.register`、`fields.register`、`ui.slot`），不通过主工作流空导入证明成员已加载。规划须确认成员身份、接口支持和冻结案例；候选须在完整组合注册表中验证该成员实际贡献，并通过对应隔离 Workspace 案例。证据分别记录验证时成员版本及最终候选成员版本；继承按 `(capability, provider)` 去重，同类能力的不同成员不能相互覆盖。停用成员不标记为可用；查询与服务占位接口不能成为可执行能力声明。

内置工作流源码和生成 bundle 统一通过 `./contract.js` 导入工作流类型，宿主在候选构建时注入可信契约。导入和保护能力检查基于语法树；字符串、注释、正则及静态属性名称不等于运行引用，真实全局能力、动态导入、外部类型导入和编译引用仍阻塞。`any` / `enum` 属于原预算内可纠正的构建错误。插件使用带自有方法的普通对象，宿主不反射类原型方法。

## UI 贡献（2026-09-09）

宿主白名单槽位目前仅 `task.detail`。`HOST_UI_SLOTS` 即「宿主已实现该槽位渲染与动作分派」的门闩，须与前端任务详情渲染契约同步维护。插件经 `contribute().uiSlots` 登记可序列化 **UI 贡献**，形状为 `{ slot, id, title, body?, actions:[{ commandId, label }], fields?:[{ key, label }], order? }`；同槽多条按 `order`（缺省 0）再 `id` 稳定排序。宿主在组合摘要中暴露已解析的 `composition.uiContributions`，以及对声称 `task.detail` 但校验失败的 `composition.uiContributionFaults`（替代态）；未知 slot 仅跳过、不上屏。打开任务详情时用当前 `task` 绑定只读字段值，动作经既有 command / revision 路径写入，不新开平行写入口。非法贡献或 command 失败不得拖垮受保护外壳（停止自迭代、应用确认、恢复）。

`ui.slot` 能力状态：白名单槽位存在至少一条合法贡献时为 `active`；无贡献为 `declared`；仅有非白名单或非法登记时为 `stub`。`business/view.ts` 只服务候选体验摘要 `{title,fields}`，不作为任务页 UI 贡献源。

隔离体验：解析与任务页同一套 `uiContributions` 描述；待应用候选经 `experience` 命令打开宿主绑定的隔离会话（运行、候选、组合版本与验收证据），默认合成测试任务，写入仅落隔离库。浏览器经 `/api/experience` 访问，不能指定数据库路径；仍保留 `domain.experience()` 供结构级模拟报告（非浏览器主路径）。

架构目录中其余扩展点（`query.filter|sort`、除 workflow 外的 `service.provide`）可登记并出现在 `composition.extensions` 能力摘要中，状态为 `stub` 或 `declared`，本阶段不改变查询 SQL。不恢复 V1 capability broker / 容器市场。`workflow/1` 验收继续有效；存在非空扩展贡献时标记 `extensions/1`。生成侧 `business/contract.ts`（evolution `contract` 字符串）须包含可选 `contribute` 与钩子方法签名。真实 Runtime 子进程须能反射并调用这些方法。自迭代 Agent 仍不能修改本类宿主约束。
