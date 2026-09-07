# 哆啦AI梦 · Todo by Cordis

架构优雅的本地自迭代软件模板，Todo 仅作为示例业务。任务优先，AI 助手按需呼出。

当前界面使用 Tailwind CSS 4.3.3、Base UI 1.8.0 和 Lucide 图标，参考 Microsoft To Do 的极简布局。任务直接在列表底部添加，点击任务编辑备注；完成、重新打开、搜索、分页、删除与撤销均已接入持久化数据。

## 运行

Node 24.18.0、pnpm 11.21.0：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 http://127.0.0.1:4517 。首次启动为空列表。服务仅监听本机，数据库默认在 `.runtime/workspace.db`；`DATABASE_PATH` 可指定独立数据库，`PORT` 可更换端口。开发时 `pnpm dev`，访问 http://127.0.0.1:5173 。开发与生产默认共用数据库和后端端口，不要同时启动。

停止服务后复制 `.runtime` 目录即可备份；恢复时同样先停止服务。

## 界面与 AI 边界

- 主界面只显示任务、筛选、搜索与添加；详情在侧栏中编辑，关闭时保留草稿。
- AI 助手通过常驻按钮呼出，不占用导航或独立页面。工作区设置和版本记录位于右上角“更多选项”。
- AI 面板已支持服务端状态契约：需求分析、追问、方案确认、执行步骤、成功、失败和取消；收起不取消执行，刷新后从服务端读取状态。
- 服务端使用官方 `@google/genai` 与 `gemini-3.1-pro-preview`，通过 `models.generateContent` 显式处理工具调用。密钥保存在 Git 忽略的本地 `.env`：`GEMINI_API_KEY=...`；没有密钥时如实显示未连接。密钥不传给浏览器或插件。
- 自然语言由模型结合当前任务、插件源码与公开契约路由。任务操作复用 Workspace 命令；新建/修改插件先生成方案，确认后才构建和执行。
- 当前支持现有工作流中的文本字段和动作表单。模型只提交 TypeScript 候选，宿主固定验收条件并独立构建、运行保护回归，通过后原子切换。修改保留插件身份和历史字段。
- 版本记录在工作区设置中，可撤回上个可用版本或选择历史版本；撤回不回滚任务数据。SQLite 与其旁边的 `artifacts/` 必须一起备份。
- 每次最多 3 个候选、12 次模型调用、10 分钟活动执行，等待确认不计时。刷新、收起后从持久化记录继续观察；宿主重启会将未完成运行标记中断，不自动再次调用模型。

`src/server` 持有 Todo 契约、数据和保护验收；`src/runtime` 只管理 Cordis 子进程；`src/evolution` 分离模型驱动、规划和工具循环；`src/release` 管理产物、构建和切换。它们共处一个工程，不建立额外平台。

## 验证与工程边界

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bench:m1
# 真实模型验收（需要 .env，会调用 Gemini 并产生 usage）
node --import tsx scripts/accept-m2.ts
```

浏览器测试与基准使用生产构建，运行前先 `pnpm build`。浏览器测试监听 4518，使用临时数据库，截图和失败证据写入忽略的 `test-results/`。覆盖 320、390、768、1280 宽度、任务操作、草稿、幂等重试，以及 AI 前端契约。

已移除 M0 的重复实验运行器、对应探针、示例数据按钮、手写流程切换界面和 `/api/releases` 演示接口。保留正式 Workspace/Runtime 的崩溃恢复、超时、版本切换及数据保留回归。旧数据库仍可加载已有复盘流程，设置中的版本恢复保留历史字段；兼容插件不再提供安装入口。

真实验收脚本使用独立数据库，将需求、方案、调用、真实 usage、候选源码、失败诊断、版本与行为证据保存到 `.runtime/acceptance-*/evidence.json`。自动回归使用显式 FixtureDriver，不能冒充真实模型证据。

基础 Todo 不依赖模型。Workspace 是唯一数据提交入口，Cordis 业务组合运行在常驻子进程中。当前不提供远程部署、多租户或恶意插件隔离保证。

## 文档

- [当前实施基线](docs/engineering/00-core-direction-v2.md)
- [产品约束](PRODUCT.md) 与 [设计规范](DESIGN.md)
- [历史 M0 报告](docs/reports/m0-validation.md)、[历史 M1 报告](docs/reports/m1-validation.md)
- [原始 PRD](docs/product/dora_ai_todo_prd_v1.0.md)

M0/M1 报告和截图保留为历史证据，所描述的演示入口已退出当前产品；实验源码可从 Git 历史恢复。旧工程方案与本轮产品方向冲突时，以当前实施基线和上述界面边界为准。
