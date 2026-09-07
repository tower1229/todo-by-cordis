# 哆啦AI梦 · Todo by Cordis

本地、单所有者的 Todo 应用。任务优先，AI 助手按需呼出。

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
- **目前没有模型或生成器。** 正式服务返回“AI 尚未连接”，不会生成模拟方案、自动推进进度或修改任务。浏览器中的 AI 方案/等待用例使用明确的测试夹具，不代表真实生成验收。

下一步从自然语言生成插件开始：服务端读取已有插件与当前版本，区分任务操作、新建插件、修改插件；信息不足先追问。方案包含需求理解、处理方式、具体改动、最终效果和数据影响，用户确认后执行。确认绑定方案 ID 和当前组合修订；执行器需持久化运行记录、幂等处理请求，独立构建验证通过后才应用变更。

接入位置：`src/shared/assistant.ts` 定义契约；`src/server/assistant.ts` 定义服务接口，`createApp` 接收实现；`useAssistant` 负责客户端观察，`AssistantPanel` 展示方案与状态。当前未实现模型路由、持久化 AI 运行记录、生成构建和发布执行器。

## 验证与工程边界

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm bench:m1
```

浏览器测试与基准使用生产构建，运行前先 `pnpm build`。浏览器测试监听 4518，使用临时数据库，截图和失败证据写入忽略的 `test-results/`。覆盖 320、390、768、1280 宽度、任务操作、草稿、幂等重试，以及 AI 前端契约。

已移除 M0 的重复实验运行器、对应探针、示例数据按钮、手写流程切换界面和 `/api/releases` 演示接口。保留正式 Workspace/Runtime 的崩溃恢复、超时、版本切换及数据保留回归。旧数据库仍可加载已有复盘流程，设置中的“恢复默认流程”保留历史字段；兼容插件不再提供安装入口。

基础 Todo 不依赖模型。Workspace 是唯一数据提交入口，Cordis 业务组合运行在常驻子进程中。当前不提供远程部署、多租户或恶意插件隔离保证。

## 文档

- [当前实施基线](docs/engineering/00-core-direction-v2.md)
- [产品约束](PRODUCT.md) 与 [设计规范](DESIGN.md)
- [历史 M0 报告](docs/reports/m0-validation.md)、[历史 M1 报告](docs/reports/m1-validation.md)
- [原始 PRD](docs/product/dora_ai_todo_prd_v1.0.md)

M0/M1 报告和截图保留为历史证据，所描述的演示入口已退出当前产品；实验源码可从 Git 历史恢复。旧工程方案与本轮产品方向冲突时，以当前实施基线和上述界面边界为准。
