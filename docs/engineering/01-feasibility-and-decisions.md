# 技术可行性与实施决策

> 历史 V1 方案。当前范围与决策以 [V2 核心实施基线](00-core-direction-v2.md) 为准，实测见 [M0 报告](../reports/m0-validation.md)。下文安全治理与原里程碑不再自动构成当前要求。

日期：2026-09-06。状态：建议实施基线；代码级技术验证尚未执行。

## 1. 判断

**可行，但工作量主体是一个有持久化发布与验证机制的插件平台，而不是 Todo CRUD。** Todo 提供稳定业务边界，使 AI 每次只需改有限契约内的插件；Cordis 提供服务组合、依赖与生命周期。可信执行、版本库、发布事务、回归验证和移动端动态 UI 仍须本项目实现。

PRD 的价值判断成立：已有应用能够增加真实生成的业务逻辑、通过服务组合继续扩展、替换工作流、依据故障生成修复并保留结果。不能从这个架构推导“任意需求必成功”，也不能把提示词或模板切换当成代码进化。

本次 GitHub 查询确认 `tower1229/todo-by-cordis` 是空仓库，默认分支元数据为 `master`，没有可评估的应用代码、依赖锁或既有 AGENTS.md。本次只建立文档；不宣称完成性能、安全或生成成功率测试。

## 2. 已核实事实与推导边界

| 证据 | 核实事实 | 对本项目的结论 |
| --- | --- | --- |
| Cordis [package.json][C1] | 固定快照中的包名 `cordis`，版本 `4.0.0-rc.9`，ESM；include/loader 为可选 peer | 采用这一源码基线做 M0；不混用其他主版本教程 |
| Cordis [Context][C2]、[Service][C3] | Context 承载服务；Service 通过 reflect 注册；isolate 是服务作用域机制 | 可替换提供者适合业务解耦；作用域隔离不等于代码安全隔离 |
| Cordis [Fiber][C4] | effect 管理清理；dispose 为异步；存在 pending/loading/active/failed 等状态 | 发布必须等待就绪、核查 active 和资源清理，不能只调用 plugin 就报成功 |
| dsh [Primer][D1] | inject、服务接口、事件派发模式和可撤销注册组成插件模型 | 本项目可借鉴公共契约，不绑定 dsh 的具体业务 |
| dsh [Agent][D2] | Agent 接口与具体 loop 包分离 | AI 改造驱动可以替换，记录与 UI 不依赖具体驱动 |
| dsh [tool-cordis][D3] | 动态定义是进程内临时能力；文档明确不构成安全边界；JS 无转换且异步执行存在超时边界限制 | 不直接复用 runner 作为产品执行、版本和发布系统 |
| Cordis [HMR 变更][C5] | 无 loader internals 时保留配置重载，禁用模块重载 | 产品发布不依赖内部模块缓存修改或开发 HMR |
| Node [VM 文档][N1] | node:vm 不适合充当不可信代码安全边界 | 生成代码不得在 API 宿主进程内 eval/import 执行 |

固定 Cordis 快照：`303cfd21e41aa4168d83419efe4196c414cce3d2`。固定 dsh 快照：`d347e703908d0406b7a7ef80e3a0e594d86b2215`。

`4.0.0-rc.9` 是已读源码中的版本值，不代表本次验证过 npm tarball。M0 必须验证 registry 包、integrity、Node 兼容和安装结果；若不一致，从上述源码构建内部固定产物，记录哈希与许可证。禁止使用浮动 main 或声称已安装。

## 3. 可行性分层

| 能力 | 判断 | 最难问题 | 首期落地 |
| --- | --- | --- | --- |
| Todo、响应式、草稿 | 高 | 动态动作、离线状态不误报 | React 壳与声明式页面/字段 |
| 外观与反馈修改 | 高 | 配置范围、无障碍 | 主题令牌、图标目录、受限动效描述、音效资源 ID，均有版本 |
| 生成字段＋逻辑＋徽标 | 中高 | 隔离、状态竞争、真实生成质量 | SDK + TS 插件 + 窄 RPC + UI 描述 |
| 插件继续扩展插件 | 中高 | 服务发现、类型和依赖治理 | Schema 目录、代理服务和依赖锁 |
| 核心工作流替换 | 中 | 存量状态、旧客户端与在途命令 | 短事务决策、排空、显式状态映射 |
| AI 驱动替换 | 中高 | 持久任务的执行归属 | 固定驱动版本；安全边界切换 |
| 自动修复 | 中 | 正确性标准和可复现输入 | 先复现，固定 oracle，再生成候选 |
| 任意 React/依赖/宿主代码生成 | 不纳入 P0 | 隔离与兼容面过大 | 只通过维护者升级 SDK 扩大能力 |

自由业务逻辑仍是真实生成的 TypeScript，不是只能选择固定估时模板。受控 UI 限制的是浏览器执行权限，不是插件能提供的业务能力。当前协议缺少组件/外部服务时，明确返回能力缺口。

## 4. 默认技术决策

以下为本项目设计选择，并非第三方保证。未选择具体补丁版本的依赖，在 M0/M1 安装时固定精确版本、镜像 digest 和 lockfile，不使用 `latest`。

| ADR | 决策 | 理由与代价 |
| --- | --- | --- |
| 001 | Cordis 独立使用，不 fork 完整 dsh | 避免引入会话/终端/插件系统的额外耦合；借鉴其接口分离，需要自建改造执行器 |
| 002 | TypeScript monorepo；pnpm；React + Vite；Hono + Node 24 LTS 系列 | 前后端共享契约；基础交互不需要 SSR。实际补丁版与 Cordis 配对由 M0 验证 |
| 003 | SQLite + Drizzle；单 API 权威写进程；本地持久卷 | 适合单用户与短事务；WAL 仍是单写者，禁止网络文件系统上共享 WAL [S1] |
| 004 | 构建与生成逻辑运行在独立受限 Linux 容器 | 超时可终止；主服务和密钥不在执行环境内。容器共享内核，不能宣称任意恶意代码绝对安全 [S2] |
| 005 | 浏览器只解释声明式 UI；业务 JS 在服务端隔离 runner | 避免远程代码进入主页面；复杂任意 UI 延后，不取消字段、布局和工作流扩展 |
| 006 | 内容寻址产物＋数据库组合版本；准备/排空/提交/确认协议 | 不把 Cordis 热重载误当跨 DB/浏览器事务 |
| 007 | 默认 Agent loop 为可替换系统插件 | 模型只提出计划/候选；执行记录、权限和发布门禁独立 |
| 008 | 首个模型适配器实现受控文本/工具调用和结构化响应 | 具体 provider/model 由部署者配置并运行能力探测；不写死不存在的模型能力 |
| 009 | HTTP 命令＋SSE 状态流 | 更少双向连接状态；SSE 可重放，但 DB 状态才是权威 |
| 010 | Vitest 领域/契约测试；Playwright 浏览器验证 | 保护性测试由维护者管理；AI 可新增候选测试，不能更改门禁 |
| 011 | 可信网络 HTTPS 手机访问＋实例所有者会话 | 本机首次运行可自动建立受限会话；无模型凭据不妨碍 Todo，远程仍必须认证 |
| 012 | 系统提供者可替换，治理权限不可由普通生成插件取得 | 满足核心插件化；避免“自进化”同时修改自己的权限与评判标准 |

## 5. 需要澄清的 PRD 工程含义

1. **“所有节点可扩展”**：公开业务边界，不开放内部函数、数据库连接或 DOM。服务调用可以被代理到新插件，但不能绕过领域提交不变量。
2. **“存储也为插件”**：提供 `TaskRepository`/`ArtifactStore` 等公共接口；P0 使用默认 SQLite/本地卷，替换存储仅维护者操作、离线迁移，不承诺运行中切 DB。
3. **“核心循环也为插件”**：Todo 工作流和 AI 调度驱动确实可替换；bootstrap、授权检查、事务版本约束和恢复路由是保护边界。模块化不等于谁都能热改。
4. **“热切换 ≤2s”**：只是兼容短命令的目标。生成、预加载、移动预览在锁外；无法排空时中止发布，继续旧版。长 LLM 调用不占任务命令事务。
5. **“发布成功”**：区分服务端已切换与客户端已确认。无人在线不能伪造 ACK；业务状态可以停在待客户端确认，且不能误报版本未生效。
6. **“自修复”**：错误结果只有在具有独立期望、领域不变量或用户反馈时可识别。没有异常不等于结果正确；无法复现时只称已缓解或未复现。
7. **“回退”**：创建新的组合修订指向旧产物，保留新任务/字段。review→open 是需要确认的数据映射，不是整库回档。

## 6. 风险排序与停止条件

先证明隔离 RPC、核心流程替换和发布恢复，再开发漂亮的 AI 对话页面。若 M0 无法硬终止代码、隔离宿主或保存已确认数据，代码生成发布保持禁用；仍可演示配置和基础 Todo，但不能宣称完成 PRD。若候选生成质量低，缩小一次改造规模和上下文，不删除验证门禁。

没有真实模型测试数据时，不估计生成成功率。工作量估计与分期见 [开发计划](05-delivery-and-acceptance.md)。完整 P0 包含 42 项验收，不能按普通 Todo 的数天工作量估算。

## 7. 来源

以下为本次读取的一手材料；源码链接固定提交。设计中超时、表结构、API、分期和选型是本项目提出的方案。

[C1]: https://github.com/cordiverse/cordis/blob/303cfd21e41aa4168d83419efe4196c414cce3d2/packages/core/package.json
[C2]: https://github.com/cordiverse/cordis/blob/303cfd21e41aa4168d83419efe4196c414cce3d2/packages/core/src/context.ts
[C3]: https://github.com/cordiverse/cordis/blob/303cfd21e41aa4168d83419efe4196c414cce3d2/packages/core/src/service.ts
[C4]: https://github.com/cordiverse/cordis/blob/303cfd21e41aa4168d83419efe4196c414cce3d2/packages/core/src/fiber.ts
[C5]: https://github.com/cordiverse/cordis/commit/303cfd21e41aa4168d83419efe4196c414cce3d2
[D1]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/docs/cordis-primer.md
[D2]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/README.md
[D3]: https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/extensions/tool-cordis/README.md
[N1]: https://nodejs.org/api/vm.html
[S1]: https://www.sqlite.org/wal.html
[S2]: https://docs.docker.com/engine/security/
