# 数据、API 与前端协议

> 历史 V1 草案。当前以 [V2 核心实施基线](00-core-direction-v2.md) 为准；本文完整表结构、认证与审批端点不作为一次性实施清单。

状态：拟实施 v1；表与端点尚未实现。所有 JSON Schema 在实现时集中放 packages/contracts，服务端运行时验证；不只依赖 TS。

## 1. 数据结构与索引

SQLite 开启 foreign_keys、WAL；短事务、单权威写服务、合理 busy_timeout。时间戳 UTC，展示用工作区 IANA 时区。任务文本不自动改写；标题 trim 后最多 200 Unicode code points、描述 5000；前后端同一计数函数。

| 表 | 主要字段 | 约束/索引 |
| --- | --- | --- |
| workspaces | id、timezone、activeCompositionId、releaseEpoch | 首期一行；epoch 单调递增 |
| tasks | id、title、description、state、workflowId、workflowVersion、revision、inputRevision、createdAt、updatedAt、completedAt、deletedAt | revision≥1；索引 deletedAt/state/createdAt/id |
| field_definitions | workspaceId、key、ownerPluginId、schemaJson、schemaVersion、retiredAt | 唯一(workspaceId,key)；定义停用仍保留 |
| task_field_values | taskId、fieldKey、valueJson、valueRevision、source、manualOverride、inputHash、ruleVersion、updatedAt | 主键(taskId,fieldKey)；值变更同时提升 task.revision |
| operations | workspaceId、operationId、requestHash、status、responseJson、committedAt | 唯一(workspaceId,operationId)；与业务写同事务 |
| outbox | seq、eventId、taskId、revision、type、changedPaths、source、payloadRef、createdAt | eventId 唯一；seq 单调，用于重放 |
| deliveries | eventId、subscriptionId、pluginVersionId、status、leaseUntil、attempts | 唯一(eventId,subscriptionId,pluginVersionId) |
| jobs | id、kind、dedupeKey、pluginId/versionId、inputHash、ruleVersion、status、leaseEpoch、leaseUntil、attempts、resultRef | 唯一(kind,dedupeKey)；索引 status/leaseUntil |
| plugin_versions | pluginId、versionId、sourceHash、bundleHash、manifestHash、artifactRef、createdAt | versionId 唯一；发布后不可变 |
| compositions | id、parentId、lockJson、configJson、grantHash、catalogHash、createdAt | 精确锁含所有版本；追加式历史 |
| changes | id、baseCompositionId、driverVersionId、intent、planRef、candidateRef、status、attempts、budgetJson | 同工作区一个活动写变更租约 |
| change_steps | changeId、stepId、status、inputHash、outputRef、startedAt、endedAt | 唯一(changeId,stepId)，防止重启重复提交 |
| approvals | id、candidateHash、baseId、grantHash、migrationHash、testReportHash、actor、expiresAt、consumedAt | 单次使用；不接受普通插件创建 |
| publications | id、oldId、newId、epoch、stage、migrationJournalRef、clientAck、error | 崩溃恢复事实来源 |
| incidents | id、pluginVersionId、fingerprint、repairFamilyId、classification、status、count、lastSeen | 5 分钟聚合窗口；family 尝试计数跨版本继承 |
| regression_cases | id、oracleHash、fixtureHash、origin、scope、protected、createdAt | 基线不由生成任务改写 |
| model_calls | id、changeId/jobId、purpose、modelRoute、requestDataClasses、usageJson、cost、status | 成本不可得时 cost=null；预算在调用前预留 |
| audit_events | seq、actor、action、target、traceId、metadata、createdAt | 追加；默认无正文；授权、发布与恢复可追踪 |

API 的 `Task.extensions` 是 field_values 聚合得到的对象，不必在 tasks 再保存一份 JSON。数字值用数字，不能把“约 20 分钟”写进数字字段。日期字段使用 `{instant, timeZone}`；若只要日期语义，单独 date 字符串，不能假装午夜 UTC 等同所有时区的那一天。

## 2. 事务与幂等

写请求带 Idempotency-Key、expectedRevision 和 compositionRevision。`requestHash` 对语义输入规范化计算；同 key 同输入重放已保存响应，同 key 不同输入返回 409 IDEMPOTENCY_MISMATCH。

在同一 DB 事务内：核实组合/epoch与 revision → 更新 tasks/字段 → 插入 outbox → 写 operations 响应。事务前可以做短流程决策，但提交时必须重查基线；不在 SQL 事务里 await LLM、用户输入或容器网络调用。

响应丢失时客户端按 operationId 查询；operations 不早于业务保留期清理，P0 不自动删除已提交幂等键。失败且未提交可返回明确失败记录；无法判断的请求先查状态，不能换 key 自动重发。

两个客户端冲突返回当前 revision 和允许重新应用的字段差异，保留本地草稿。只提交 patch，不发整个旧 Task 替换。状态、workflowVersion、completedAt 不允许普通 PATCH 写入。

完成时间由 workflow 的状态类别和实际提交计算。默认 reopen 清除当前 completedAt，历史完成事件仍在 outbox/audit；撤销也是新命令，需校验期间是否发生新修改，不能无条件覆盖。

## 3. 估时异步一致性

`inputRevision` 只在标题/描述等估时输入变化时增加，普通 task.revision 在任意写入时增加。通用插件可声明输入字段集合，宿主对其快照计算 `inputHash`；不要求所有插件共享同一个 inputRevision。

去重键为 taskId＋inputHash＋ruleVersion。规则改变必须改变 ruleVersion，不能通过仅改显示版本规避重算语义。job 还记录实际 pluginVersionId 供诊断与租约校验。

1. task.created 提交后，outbox 订阅者登记唯一 job；写估时排队状态不能再次触发估时。
2. worker 领取带 leaseEpoch 的 job；LLM 调用由 broker 记录用途、字段和预算。业务并发默认 2，网络重试最多 2 次。
3. 将响应验证为 1–1440 的整数分钟或明确 unknown；范围是初版默认产品规则，可版本化配置。NaN、Infinity、字符串与负数拒绝。
4. 结果提交事务重新检查：任务存在且未删除、inputHash 未变、manualOverride 未置位、job leaseEpoch 仍有效、生产插件版本授权仍有效。
5. 不符合条件标记 discarded/stale，不覆盖；符合条件只 patch 自己的字段，提升 revision 并发出 source.pluginId 的更新事实。
6. 仅标题/描述等相关路径变更触发新 job。人工值优先；“AI 覆盖我的估时”产生一次绑定 valueRevision/inputHash 的明确授权，新人工编辑会令它失效。

挂起 job 在插件停用或发布排空时取消并撤销 lease；迟到响应不能写。重启后租约过期任务可重试，但已经写回的 dedupeKey 不重复写。模型提供者可能重复计费，不能宣称外部推理 exactly-once；本地结果提交保持幂等。

“20 分钟内”筛选为 `estimateMinutes exists AND 1<=value<=20`，默认只纳入 complete/manual 状态。unknown、未估时、失败及缺值均排除并在 UI 说明。筛选插件读取原字段，不新增估时字段或模型调用。

## 4. 工作流兼容

默认定义为 open→done、done→open；类别映射由 WorkflowDefinition 提供。review 版本可定义 open→review→done，进入 review 不写 completedAt。提交复盘用 input-required 表单；关闭表单不会变 done。任务已进入 review 后取消表单保留 review，明确动作“取消完成”可回 open。

升级预检所有实际存在状态、动作和字段，输出受影响任务数量及映射摘要。P0 限单一活动工作流：在停写事务内为 open/done 保持状态，更新 workflowVersion；兼容证明写入迁移记录。回退时 review→open，保留复盘字段。升级后新增任务及人工改动不能被快照覆盖。

如状态映射不是全函数、缺必需字段或存在无法排空长流程，拒绝自动切换。P0 不实现任意多版本长流程并行。

## 5. API 草案

所有 `/api/v1` 端点认证；写入检查来源/CSRF、配额与所有者权限。响应错误统一为 `{code,message,traceId,retryable,details}`，details 脱敏。基础 CRUD 不要求模型连接。

| 方法与路径 | 输入/输出关键点 |
| --- | --- |
| GET /tasks | search、category、filterIds、sortId、cursor；返回任务投影与 allowedActions |
| POST /tasks | title/description/扩展初值；Idempotency-Key；返回 Task+operationId |
| GET /tasks/:id | 任务、字段定义、动作、当前 revision |
| PATCH /tasks/:id | expectedRevision、受控 patch；拒绝直接状态写 |
| POST /tasks/:id/actions/:actionId | expectedRevision、input、continuation?；返回 reject/input-required/committed |
| DELETE /tasks/:id | expectedRevision；软删除、undo 信息 |
| POST /tasks/:id/restore | expectedRevision；支持 8 秒快捷撤销与回收站恢复 |
| GET /operations/:id | pending/committed/failed 与权威响应 |
| GET /capabilities | 目录摘要、catalogHash；可按接口查询完整 Schema |
| GET /composition | active revision、epoch、UI 描述引用与 protocolVersion |
| POST /changes | 自然语言、scope、baseCompositionId；202 返回 changeId |
| GET /changes/:id | 真实步骤、预算、候选与测试报告，不伪造进度 |
| POST /changes/:id/cancel | 幂等；提交段只能等待提交/恢复结束 |
| POST /changes/:id/revise | candidateId、补充需求；新候选使旧审批失效 |
| GET /candidates/:id/preview | 单独预览会话；访问复制数据，不能写生产或正式通知 |
| POST /candidates/:id/approve | candidateHash、base、grants、migration、testReport 的摘要绑定 |
| POST /candidates/:id/publish | 引用 approvalId；由发布器复核，不允许绕过 |
| POST /compositions/:id/rollback-plan | 输出当前数据上的兼容映射与影响；不直接回档 |
| POST /plugins/:id/enable 或 disable | 先返回依赖计划，确认后走组合发布 |
| DELETE /plugins/:id | 默认保留字段与版本；数据清除为独立明确操作 |
| GET /incidents/:id | 归属、复现证据、修复状态；正文按授权脱敏 |
| GET /events | SSE，Last-Event-ID；允许重放，过期 cursor 返回 resync-required |
| POST /clients/:id/ack | revision、UI hash、smokeResult，确认新协议已加载 |
| GET /export | 任务、字段定义、版本引用；密钥排除 |
| POST /imports/validate | 仅解析、校验、影响预览，不执行包 |
| POST /imports/:id/apply | 明确确认后导入数据；代码另走验证授权 |
| GET /recovery | 独立可信页面；不依赖用户插件或主 UI 渲染成功 |

清空工作区、模型配置和恢复操作另走所有者设置接口，不向普通插件暴露。模型 base URL 只由维护者配置，限制 scheme/host；生成插件不能通过代理构造任意 SSRF 请求。

## 6. 前端缓存与版本握手

SSE 传递带 seq/operationId/compositionRevision 的事实摘要；客户端去重，按需重新查询，不能把流当唯一数据源。断流重连先比较 revision 再恢复。可用缓存显示最后同步时间，断网只保留草稿，不自动队列写入。

任务草稿与服务器快照分开，按 taskId/fieldKey/schemaVersion 存 IndexedDB；输入不要因查询刷新被覆盖。新字段 Schema 不兼容时把草稿保留为待处理文本，不静默丢弃或自动提交。注销/清空本地数据可清理草稿，浏览器缓存不持久存认证 token。

界面请求携带组合版本；旧客户端收到 409 COMPOSITION_STALE 后停写、保留草稿、拉取新描述并重新握手。协议主版本不兼容时提示重新加载，P0 热发布仅允许当前壳支持的协议；不伪称能热升级所有前端代码。

## 7. 移动端实现细则

路由按 PRD：/tasks、/tasks/:id、/ai、/plugins、/plugins/:id、/changes/:id、/settings。320–767 单列底部导航；768–1199 最多列表/详情双栏；1200 以上允许 AI 并排，主内容不足 480 时收起。

列表、详情、AI 状态分别缓存；返回恢复筛选/滚动/草稿。手机预览独立全屏页，带“尚未应用”；审批页列出功能、数据、权限与撤回影响。打开代码差异不再叠第三层模态。

动态表单由 Schema 生成 label/error/description；主要触控区 44 CSS px；支持 320 重排、200% 文字、键盘焦点、screen reader 状态播报。输入框考虑 safe-area 与 VisualViewport；中文 composition 期间 Enter 不提交；手机 AI 输入 Enter 换行，显式发送。

插件 UI 按容器布局而非屏幕断点，任务行有限徽标、多余折叠。减少动态效果与静音先由宿主执行，再应用插件偏好；自动播放拒绝只降级反馈。Error Boundary 覆盖渲染，动作/异步由命令与调用包装器单独捕获。

## 8. 保留、备份与恢复

原始故障上下文默认 7 天、脱敏摘要 30 天；经授权转成去敏回归后可长期保留。任务软删保留 30 天。当前/最后可用组合及其依赖产物不得 GC；GC 先计算历史、候选和备份引用，再清理不可达对象。

备份使用 SQLite 一致性备份接口并保存引用产物，不直接复制一个可能遗漏 WAL 的 db 文件。导出包含 Schema 与来源/人工标记。导入先检验大小、路径、Schema、冲突和哈希；代码只能进入候选态。恢复演练必须证明重启后的字段、人工值和活动组合一致。
