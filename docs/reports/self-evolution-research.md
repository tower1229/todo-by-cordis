# 自迭代核心：一手研究与精简建议

研究日期：2026-09-06。本文区分已核实事实、架构推断和待测项目；性能结论以本机基准为准。用户最新原则优先：高性能、架构简单优雅、自迭代成立、演示界面精美。原工程文档的安全平台要求不再自动构成当前范围。

## 结论

**建议默认采用一个常驻 Node 子进程承载整个 Cordis 插件组合，进程内服务直接调用；主进程仅保留 API、持久数据与版本切换、运行监督。** AI loop 是可替换实现，产物和验证结果持久保存。候选验证通过才替换活动组合，失败继续旧版。

这是面向自迭代连续性的选择：生成代码卡死以后仍要有人能终止它、读取失败记录、继续改进。无需为此引入容器、逐插件权限代理、多租户、审批签名、分布式租约或通用治理平台。单个业务命令跨执行边界一次；插件 A 调插件 B 不跨进程。

“性能最高”必须落成可测目标：正常交互延迟、每次有效改进的时间和 token 成本、连续替换后的内存、失败恢复时间。单次空函数调用最快的架构，不一定能更快完成连续改进。当前没有足够实测数据宣称全局最优。

## 1. Cordis 发布包现实

本次通过 npm 官方注册表查询核实 `cordis@4.0.0-rc.9` 已发布，并直接阅读本仓库安装后的 `node_modules/cordis/package.json`、`lib/fiber.d.ts` 和 `lib/index.js`。可复现查询：

```powershell
npm.cmd view cordis@4.0.0-rc.9 version dist.integrity dist.tarball engines dependencies --json --fetch-retries=0 --fetch-timeout=15000
```

- 产物：[官方 npm tarball](https://registry.npmjs.org/cordis/-/cordis-4.0.0-rc.9.tgz)。integrity 为 `sha512-Y18SoewBvJ0eTZK7lHSQ5xl5YT1OWwoqFI92UrtpSAZyjUcW7cIEAOgOBVFp7PtO605vx6gBWdiOVaxY6UmSGw==`。
- 安装包为 ESM，入口 `lib/index.js`，MIT；直接依赖 `@standard-schema/spec ^1.1.0` 和 `cosmokit ^1.8.1`；include/loader 是 optional peer。基线不需要搭配 loader 才能使用 Context。
- `FiberState` 有 `PENDING`、`LOADING`、`ACTIVE`、`FAILED`、`DISPOSED`、`UNLOADING`。`await()` 等待迁移并重新抛出启动错误；不能仅以 `ctx.plugin()` 返回作为就绪证据。
- **实物中的 `_unload()` 使用 `Promise.all` 等待各 disposer，并捕获清理异常写入 logger。** 不能假定异步清理严格串行，也不能把 `dispose()` 未抛错当成清理无错误。详见安装包 `lib/index.js` 的 `_reload`、`_unload` 和 `await` 实现。

原文档所引 Cordis 提交 `303cfd21e41aa4168d83419efe4196c414cce3d2` 本轮网页读取失败，故没有声称重新核实该提交。DSH 的 [vendored Cordis](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/vendor/cordis/src/fiber.ts) 使用 `@deepseek-ai/cosmokit` 且存在不同实现，**不能把其注释和行为直接当成 npm rc.9 的保证**。当前适配与验证以锁定安装包为准。

推断：Cordis 的价值是统一依赖和生命周期，项目只需一层薄适配来确认就绪、汇集失败和释放资源；自行复制服务容器、生命周期树与事件系统会增加重复概念。先用真实失败、依赖替换和重复启停实验验证这个边界。

## 2. dsh 值得借鉴什么

固定参考快照：`d347e703908d0406b7a7ef80e3a0e594d86b2215`。

**事实：** dsh 把 `Agent` 接口、注册和事件词汇放在 agent 包；具体 loop 注册 factory，消费者不直接依赖 loop。默认 loop 核心是组装请求、调用模型、执行工具、记录结果、继续下一步；取消是协作式，工具并发有上限。其自身说明没有内建 turn budget。[Agent 契约](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent/README.md)、[Agent loop](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/core/agent-loop/README.md)。

**事实：** 动态插件工具支持检查实际服务接口、定义不可变版本、运行/更新、读取诊断和停止。定义默认只保存在当前进程内存，不修改仓库、安装包或配置，重启会丢失。[tool-cordis](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/packages/extensions/tool-cordis/README.md)。

**项目推断：** 借鉴 `inspect → generate → verify → activate → observe` 和接口/实现分离，不 fork 全部 dsh。只给模型当前相关接口、活动版本、目标与失败证据；先串行执行修改与发布，独立只读工具才并行。设置每轮尝试上限、时间和 token 预算，以限制无效重复；这是迭代效率控制。项目必须额外持久化版本和观测结果，否则只能展示临时扩展。

保持请求前缀稳定、按需注入相关接口是值得验证的优化；不要每轮塞入全仓库和全部工具。这是由 loop 的请求构造与历史增长机制推导的策略，不能在未测 provider 的情况下承诺缓存命中率。

## 3. 三种运行方式

| 维度 | 宿主直接 import | 单组合 Worker | 单组合子进程 |
| --- | --- | --- | --- |
| 插件间调用 | 直接调用 | Worker 内直接调用 | 子进程内直接调用 |
| API 到业务调用 | 无跨界序列化 | 一次消息往返 | 一次 IPC 往返 |
| 同步死循环 | 阻塞宿主，宿主 timer 无法自救 | 父线程可请求 terminate | 父进程可终止子进程 |
| 故障范围 | 与监督器相同 | 独立 JS 引擎，但仍同一进程 | 独立进程内存和 V8 |
| 长期模块替换 | 需处理 ESM 缓存寿命 | 重建 Worker 释放其环境 | 重建子进程释放其环境 |
| 资源与启动代价 | 最少结构性开销 | 有启动/消息开销 | 有进程/IPC 开销 |
| 当前建议 | 作为调用成本对照 | 待测替代方案 | 默认原型，常驻并按组合替换 |

表中相对成本是结构分析，不是实测排序。

**Node 官方事实：** Worker 适合 CPU 密集 JS，I/O 工作通常不会因此变快；频繁新建 Worker 的成本可能抵消收益。`terminate()` 尽快停止 JS 并在退出后兑现 Promise。`resourceLimits` 只约束 JS 引擎，不涵盖 ArrayBuffer 等外部数据；全局 OOM 仍可能使整个进程 abort。它不能提供独立进程级别的 native crash 故障域。[Node 24.18 Worker](https://nodejs.org/download/release/v24.18.0/docs/api/worker_threads.html)。

**Node 官方事实：** `fork()` 启动独立 Node 进程，独立内存/V8，并提供 IPC。`kill()` 成功表示信号发送成功，不等于已退出；应等待 exit/close。Windows 的相关信号会强制终止；Linux 杀父进程不会自动杀孙进程。[Node 24.18 child_process](https://nodejs.org/download/release/v24.18.0/docs/api/child_process.html)。

推断：采用直接 `fork` 而非 shell 包装、一个组合一个常驻进程，启动开销只在冷启动和版本切换支付。常规释放先等待 Cordis 清理，超时再终止；不要在强制退出后假定 finally 或清理器运行过。native crash 独立性是选子进程的理由，但子进程本身也不保证机器资源耗尽时宿主必定存活。

**Node 官方事实：** ESM 按 URL 缓存；不同 query/fragment 会创建不同模块；`require.cache` 不管理 ESM 缓存。[Node 24.18 ESM](https://nodejs.org/download/release/v24.18.0/docs/api/esm.html)。

推断：不要用持续追加 `?t=...` 作为无限生命周期的发布策略。候选使用不可变目录，必要时整个组合运行环境重建，避免依赖内部缓存删除。关闭 Fiber 释放插件副作用，不等于卸载整个模块图。

## 4. 最小架构与应删内容

建议先按模块组织而非预建十多个 package：

1. `web`：精美 Todo 与迭代状态，少量稳定展示组件。
2. `host`：HTTP/SSE、单一持久化入口、活动版本指针、运行监督。
3. `runtime`：一个常驻子进程和一个 Cordis Context；业务与 loop 可替换。
4. `evolution`：模型适配、生成、候选检查、切换与失败记录。

保留：稳定公共接口、真实源码产物、内容哈希、活动/上一版本、基本领域验证、超时终止、数据保留、少量可重放迭代记录。版本候选检查也使用组合运行环境，不另造测试专用插件语义。

删除当前实施要求：容器部署前置、细粒度 capability broker、逐插件 JSON RPC、权限/签名 manifest、审批摘要、独立治理包、攻击测试集、跨实例租约、浏览器 ACK 作为发布成功前提、泛化服务市场、任意存储热迁移。需要这些能力时再引入，不保留空壳。

简化发布为：构建不可变候选 → 用任务快照验证 → 暂停短命令并排空 → 持久化活动指针并切换运行引用 → 恢复命令。只保留一个发布操作和一个活动写者；候选阶段不写真实任务数据。若新版本已接受真实任务写入，撤回仅切换代码引用，不能回滚整库。需要数据不兼容迁移时单独处理，首个演示只做增量字段与兼容流程。

这里保留的数据完整性属于“系统能持续迭代”的必要条件。删除它会让第二次进化抹掉第一次成果，无法完成核心目标。

## 5. 验证与视觉交付

第一轮仅验证：锁定 Cordis 的依赖激活/失败/异步清理/20 次启停；直接调用与常驻 Worker/子进程同载荷往返；启动、切换、超时终止和连续替换后的资源走势。记录环境、样本数量、预热和 p50/p95，分开冷启动和稳定态。不把空 ping 的吞吐量当 Todo 或 AI 工作流整体性能。

第二轮做一条真实进化：默认完成任务 → 生成“完成前补一句复盘”的工作流 → 验证 → 生效 → 注入一个可重现错误 → 修复 → 保留同一批任务数据。每次只改一个能力，验证集包含目标场景和原有任务操作。

美术无需等待平台完备：第一张页面即应体现统一字体、留白、材质、层次、移动端触感和细腻状态动效；演示只需一个任务列表、一条改造入口、一张改造前后卡片。首期用少量优质组件直接实现，不先构建通用 UI DSL。运行版本与真实迭代状态进入画面，尚未连接模型的效果必须明确标注为预览。是否吸引人由实际浏览器截图与交互审查判断。

研究完成后已追加 [M0 实测](m0-validation.md)：子进程/Worker 小载荷开销、基础流程替换与事务恢复已取得探针证据。仍未证明真实模型生成/修复成功率、长期内存上界、生产完整发布恢复与最终视觉质量。
