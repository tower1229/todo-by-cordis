# 哆啦AI梦 · Todo by Cordis

移动端优先的 AI 驱动 Todo Web 应用：用户通过对话生成、组合和修改插件，使同一应用与同一批任务数据持续获得新能力，并在独立验证约束下尝试自修复。

**当前阶段：已完成第一轮 M0 核心机制实验，尚无可用 Web 应用或真实 AI 生成。** 15 项测试通过，保留运行基准与流程/事务恢复实验。

当前原则：自迭代、性能、简单优雅的架构优先；演示功能精简，界面必须明亮、精致、富有生命感。旧文档中的安全治理平台不再是当前实施前置。

## 当前入口与运行

- [V2 实施基线](docs/engineering/00-core-direction-v2.md)：最新范围、精简架构、视觉方向与里程碑，优先于旧工程文档。
- [一手研究](docs/reports/self-evolution-research.md)：Cordis/dsh/Node 事实与架构取舍。
- [M0 实测报告](docs/reports/m0-validation.md)：通过项、限制与下一步。

使用 Node 24.18.0、pnpm 11.21.0：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm bench
```

`experiments/` 是机制探针，`tests/runtime/` 是对应实验测试。没有 `pnpm dev`，也没有已接入模型的生成界面。实验夹具均为手写，不计作真实自迭代成果。

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
