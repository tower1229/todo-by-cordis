---
status: accepted
---

# 极薄监督壳与双端对称 Cordis 插件热插拔架构

2026-11-19，在完成 679 次真实模型调用与 V2 连续六步复盘后，确认以本决策取代 [ADR 0005](0005-host-extension-registry.md) 的宿主 Todo 扩展注册表与可序列化 `task.detail` 槽位方案。

## 背景与问题

本项目的核心理论基石是基于 Cordis 插件生命周期与依赖注入实现软件自迭代。但 V2 实现将每个生成插件封闭在独立的 `node:vm` 上下文中做 JSON 函数反射，切断了共享 `Context`，使插件无法原生使用 `Service`、`inject`、`bail/waterfall` 事件钩子与 `effect` 清理；宿主转而在外部硬编码了耦合 Todo 业务的 `Workspace` 与 `ExtensionRegistry`，丧失了跨业务迁移能力与全栈界面表达力。

## 决策

1. **零业务语义的极薄监督壳（Supervisor）**：受保护宿主仅负责组合版本管理、沙箱在线热备克隆验证、自迭代驱动、受保护顶栏/侧栏及乐观锁应用/故障回退，不包含任何 `Task`、工作流状态或具体业务表结构。基础业务本体（如 `todo-core`，或迁移至其他业务时的核心模块）本身作为普通可替换的 Cordis 插件运行。
2. **双端对称的真实 Cordis 运行时与单例模块共享**：废除孤立 `node:vm` JSON 桥，在受监督业务子进程与浏览器应用区分别运行真实的服务端 `Context` 与客户端 `Context`。全栈插件按内容寻址 ESM 产物加载，共享同一端内 `Context`：
   - **不可伪造插件身份与静态 `ScopedDb` 绑定**：宿主挂载插件 `P` 时通过私有 `Symbol` 注入受信任身份（`rootCtx.extend({ [HOST_PLUGIN_ID]: P.pluginId })`），不信任插件自报 `name`；`ctx.db` 在插件或 `Service` 初始化读取时即固化绑定所属 `pluginId`，避免下游调用上游 `Service` 时因 Cordis 动态 `caller` 代理误判越权；
   - **引擎级数据库隔离与在线克隆**：服务端 `ScopedDb` 基于 Node 内建 `node:sqlite` 的 `enableDefensive(true)` 与 `setAuthorizer` 字节码授权钩子，强制插件仅可访问 `plg_<normalizedId>__*` 自有表并拒绝 `DROP TABLE`、`ATTACH` 及删列操作；跨插件采用弱引用 ID 并在重开时惰性忽略孤儿记录；沙箱克隆统一使用 `sqlite.backup` 在线热备；
   - **浏览器 `importmap` 单例与按插件装卸样式**：宿主页面通过 `<script type="importmap">` 统一共享单实例 `react`、`react-dom`、`cordis` 与基础组件库；插件构建时按需提取编译 Tailwind CSS v4 工具类并在客户端 `effect` 中挂载/卸载专属 `<style>`，每个 `<Slot>` 插件渲染项自动包裹独立 React `ErrorBoundary`；
   - **双端钩子协同**：客户端 `clientCtx.bail` 允许下游插件渲染任意自定义 React 弹窗或向导收集输入，服务端 `ctx.bail` 执行权威业务校验防止绕过。
3. **排空保护的进程内 Fiber 热插拔与快照幂等同步**：正式环境切换组合时，服务端在短暂排空 `/api/app/*` 在途请求后执行拓扑序 `Fiber` 热插拔，并通过 SSE 下发完整权威组合快照供浏览器端幂等对账装卸（断线重连自动对齐）；仅在发生不可恢复异常或底座变更时回退为整子进程重建。
4. **防单体退化的结构与剥离不变量（Ablation Invariant）**：插件依赖必须构成单向有向无环图（DAG），严禁上游插件感知或引用下游插件。当同批修改上游插件 `U` 并新增/修改下游插件 `D` 时，沙箱强制执行 `dispose(D)` 剥离验证：若 `U` 既有测试未改（纯开接缝），`U` 必须 100% 通过原测试；若 `U` 业务同步修订导致测试变更，须在确认单显式披露 diff，且卸载 `D` 后 `U` 仍须独立达到 `ACTIVE` 并通过更新后的 `closure(U)` 子图测试。

## 后果

- 插件启停与单插件热升级成为天然的 `Fiber` 操作，彻底消除全局静态槽位白名单对业务表达力与跨业务迁移的限制。
- 插件代码必须遵守标准包结构、`ScopedDb` 命名空间与 `effect` 清理契约；未清理副作用、共享实例冲突或反向耦合的候选将在沙箱门禁阶段被确定性拦截。
