# Design

本文规定**受保护宿主监督壳（`SupervisorShell`）**的统一视觉与交互规范，以及默认示例插件 **`todo-core`** 的参考视觉风格。宿主本身零业务硬编码，所有样式与组件机制对任意业务插件平等生效。

## 技术与样式体系

- **Tailwind CSS 4.3.3 + Vite**：宿主基础主题与样式集中在 [`src/runtime/client/theme.css`](src/runtime/client/theme.css) 与 [`src/runtime/client/host-base.css`](src/runtime/client/host-base.css)；每个业务插件构建时按需编译自身 utilities CSS，随客户端 Cordis `Fiber` 生命周期自动挂载/卸载专属 `<style>` 节点。
- **Base UI 1.8.0 + Lucide**：Base UI 提供 Button、Dialog、Menu 的无障碍与焦点管理，Lucide 提供统一线性图标。不引入第二套主题或通用 UI DSL。
- **基础排版与触控**：使用 Segoe UI / PingFang SC / Microsoft YaHei 系统字体；浅色冷调中性界面 + 少量蓝色强调（仅用于主动作与选中态）；正文 14px、标题 26px、手机输入框 16px、主要触控操作 ≥ 44px，尊重 `prefers-reduced-motion`。

## 宿主监督壳（`SupervisorShell`）交互规范

- **独立根挂载**：挂载于 `#supervisor-root`，与业务根 `#app-root` 隔离，任何插件渲染异常被 `<Slot>` / 路由级 `PluginErrorBoundary` 局部拦截，绝不阻断监督壳。
- **按需自迭代抽屉**：通过极薄顶栏小型常驻入口呼出，无自动弹窗；手机占满屏，桌面允许继续操作主应用。
- **真实阶段反馈**：需求明确时直达沙箱生成与四道验证门禁（仅重大业务目标歧义或破坏性数据意图时澄清）；展示真实服务端阶段、结果与修正尝试，禁止假百分比或计时推进；离开或刷新后恢复同一次运行。
- **隔离预览与确认应用**：候选通过验证后显示“尚未应用”并可直接打开隔离预览（基于 `app.db` 在线热备克隆的真实数据），支持预览期继续对话微调与热刷新，最终单独点击“确认应用”生效，或随时在二级抽屉中查看组合状态与执行保数据撤回。
- **侧栏层次**：当前状态 → 主线内容（澄清选项 / 变更简报 / 预览微调 / 预算暂停追加）→ 底部紧凑用量与主操作。

## 示例插件 `todo-core` 视觉参考

`plugins/todo-core` 采用 Microsoft To Do 的极简风格：干净、克制、界面自身说明操作，无营销标题、鼓励语或示例填充。桌面左侧浅灰导航和搜索、主区任务列表、底部常驻添加行；手机将筛选与搜索移至顶部；任务以行呈现，圆形状态按钮完成/重开，点击正文打开备注侧栏，删除收进详情。
