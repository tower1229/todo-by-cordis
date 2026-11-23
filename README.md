# 哆啦AI梦 · Todo by Cordis (V3)

以探索简单、通用、可跨业务迁移的 LLM 软件自迭代架构为核心目标。当前主线已全面切换至 **V3 双端对称真 Cordis 全栈插件热插拔架构**：宿主监督壳（`SupervisorShell`）保持极薄且零具体业务硬编码，Todo（`plugins/todo-core`）与库存管理（`plugins/inventory-core`）均作为平等的标准全栈业务插件运行。

架构设计与演进复盘见 [基于真 Cordis 的全栈自迭代架构 V3](docs/engineering/07-cordis-self-iteration-v3.md)、[领域契约](CONTEXT.md) 与 [设计规范](DESIGN.md)。

## 快速开始

Node 24.18.x、pnpm 12.3.4：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

默认打开 http://127.0.0.1:4517 ，首次启动自动加载 `plugins/todo-core` 种子插件组合。

- **开发模式**：`pnpm dev`（直接运行 `src/v3/main.ts`，支持通过环境变量配置端口与数据目录）
- **常用环境变量**：
  - `PORT`（默认 `4517`）、`HOST`（默认 `127.0.0.1`）
  - `V3_DATA_DIR`（默认 `.runtime/v3`，保存 `control.db`、`business.db` 与运行工作目录）
  - `V3_SEED_PLUGIN_DIR`（默认 `plugins/todo-core`，切换为 `plugins/inventory-core` 即可零代码改写启动库存业务）
  - `DEEPSEEK_API_KEY`（可选，保存在本地 `.env`；未配置时日常插件与监督壳照常运行，不发起任何付费模型调用）

## 架构概览

- `src/v3/`：V3 监督壳与双端 Cordis 运行时
  - 服务端：`cordis-runtime.ts`、`worker-child.ts`、`scoped-db.ts`（SQLite `setAuthorizer` 表前缀隔离）、`http-router.ts`、`scheduler.ts`
  - 构建与四道验证门禁：`plugin-builder.ts`、`static-verifier.ts`、`plugin-verifier.ts`、`plugin-test-runner.ts`、`test-diff.ts`
  - 预览、发布与自迭代闭环：`composition-release.ts`、`preview-session.ts`、`control-store.ts`、`evolution-loop.ts`、`http-gateway.ts`、`main.ts`
  - 浏览器端：`src/v3/client/`（`importmap` 共享基座、`ClientCordisRuntime` SSE 幂等热插拔、带独立 `ErrorBoundary` 的 `<Slot>`、`SupervisorShell` 组合状态与自迭代抽屉）
- `src/evolution/`：复用的底层 DeepSeek 流式传输、预算与错误分类模块
- `plugins/`：标准全栈业务插件（`todo-core`、`inventory-core`）

## 验证与测试（默认零付费）

```sh
pnpm typecheck
pnpm build
pnpm exec playwright install chromium
pnpm test
pnpm test:e2e
pnpm accept:v3
```

所有 CI 检查、应用单测与 Playwright E2E 回归均使用确定性零付费模型桩，覆盖双端热插拔、四道验证门禁、在线克隆预览、乐观锁应用与紧急撤回、Todo 六步连续自迭代以及 `inventory-core` 跨业务迁移。

## 受控真机验收（默认关闭，遵守 STOP_SERIES 纪律）

仓库提供受显式授权标志、调用上限与费用护栏保护的 V3 真机验收入口 `scripts/accept-v3-real-model.ts`，**默认 fail-closed 关闭**，不会自动触发任何付费模型调用。仅在用户单次明确授权时执行：

```sh
V3_REAL_MODEL_AUTHORIZED=1 pnpm accept:v3:real-model \
  --authorize-paid-run \
  --scenario=all \
  --max-calls=24 \
  --max-cost-cny=8.0
```

执行后将自动归档原始模型调用（`calls.jsonl`）、真实 usage 与估算费用、验证证据（`summary.json`）及浏览器截图至 `docs/reports/v3-real-model/<timestamp>/`。

## 文档与历史归档

- [V3 架构与迁移蓝图](docs/engineering/07-cordis-self-iteration-v3.md)
- [核心目标与 V2 复盘](docs/engineering/00-core-direction-v2.md)
- [领域术语与约束](CONTEXT.md)、[产品约束](PRODUCT.md)、[设计规范](DESIGN.md)、`docs/adr/`
- `docs/reports/` 中的历史 V2 验收归档、M0/M1 报告与付费台账均保持原样不可篡改，供历史审计追溯。
