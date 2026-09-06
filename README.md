# 哆啦AI梦 · Todo by Cordis

移动端优先的 AI 驱动 Todo Web 应用：用户通过对话生成、组合和修改插件，使同一应用与同一批任务数据持续获得新能力，并在独立验证约束下尝试自修复。

**当前阶段：M1 可用 Web 应用已完成。** 支持持久化 Todo、默认/复盘工作流真实切换与撤回、明亮精致的响应式界面。流程插件为手写演示，尚未接入 AI 生成。

当前原则：自迭代、性能、简单优雅的架构优先；演示功能精简，界面必须明亮、精致、富有生命感。旧文档中的安全治理平台不再是当前实施前置。

## 当前入口与运行

- [V2 实施基线](docs/engineering/00-core-direction-v2.md)：最新范围、精简架构、视觉方向与里程碑，优先于旧工程文档。
- [一手研究](docs/reports/self-evolution-research.md)：Cordis/dsh/Node 事实与架构取舍。
- [M0 实测报告](docs/reports/m0-validation.md)：通过项、限制与下一步。
- [M1 验收与演示](docs/reports/m1-validation.md)：运行说明、验收结果、性能与截图。

使用 Node 24.18.0、pnpm 11.21.0：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 http://127.0.0.1:4517 。首次启动为空列表，可手工新增或点击“载入三件示例任务”。服务仅监听本机；数据库默认在 `.runtime/workspace.db`，开发与生产默认共用它。`DATABASE_PATH` 可指定独立数据库，`PORT` 可更换服务端口。

开发时运行 `pnpm dev`，打开 http://127.0.0.1:5173 。Vite 代理 API 到 4517；开发与生产不要同时占用同一服务端口。前端支持热更新，修改服务端代码后重启开发命令。

```powershell
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bench:m1
```

`test:e2e` 和 `bench:m1` 使用最新生产构建，运行前先执行 `pnpm build`。测试使用独立临时数据库并自动清理，不改个人任务。浏览器测试监听 4518。

`experiments/` 与 `tests/runtime/` 保留 M0 探针；正式应用在 `src/`，不导入实验 kernel。`pnpm bench` 仍运行 M0 调用微基准。

需要备份时，先正常停止服务，再复制 `.runtime` 数据目录；恢复时在服务停止状态还原该目录。M1 不提供在线备份、导入或数据库迁移界面。

## 文档入口

| 文档 | 用途 |
| --- | --- |
| [原始 PRD V1.0](docs/product/dora_ai_todo_prd_v1.0.md) | 产品需求原文，保持附件内容不变 |
| [技术可行性与决策](docs/engineering/01-feasibility-and-decisions.md) | 证据、Cordis 边界、技术选型、范围与风险 |
| [系统架构与插件契约](docs/engineering/02-architecture-and-contracts.md) | 系统组成、SDK、扩展点、权限和隔离 |
| [数据、API 与前端协议](docs/engineering/03-data-api-and-ui.md) | 数据结构、幂等、异步任务、移动端和接口 |
| [生成、发布与自修复](docs/engineering/04-evolution-release-and-repair.md) | Agent 工具、审批绑定、切换、崩溃恢复和修复证据 |
| [开发计划与验收](docs/engineering/05-delivery-and-acceptance.md) | 技术验证、工作包、42 项 AC 追踪和演示步骤 |

以下原始 PRD 与工程文档保留为历史设计参考；与 V2 冲突时以 V2 为准。

## 项目边界

首期是本地、单所有者、单工作区演示。基础 Todo 不依赖模型；业务插件在一个常驻子进程中直接组合，保留候选验证、持久版本与失败恢复。业务流程和 AI 改造驱动均可替换，非核心安全治理暂不实施。

模型、插件版本、配置、组合与测试证据需要持久化。自修复代表软件实现和回归案例得到改进，不代表模型权重自动训练。

技术基线调研日期：2026-09-06。精确上游快照与未验证项见技术决策文档。
