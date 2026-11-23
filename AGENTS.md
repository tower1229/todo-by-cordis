# 项目协作规则

## 项目上下文

- **Issue Tracker**：GitHub Issues (`tower1229/todo-by-cordis`)
- **架构与设计文档**：开工前按需阅读根目录 `CONTEXT.md`、`DESIGN.md` 与 `docs/adr/`，改动不得违背其中已确立的约束。

## 开发与验收流程

1. **复杂需求先对齐**：涉及多模块或架构边界的任务，先梳理边界条件与验收标准（AC），确认后再拆分或落地实现。
2. **独立视角验收**：完成 Issue 后，如用户要求 review，启动独立 subagent 对照 Issue AC 与 `CONTEXT.md` / `DESIGN.md` / `docs/adr/` 检查遗漏、逻辑缺陷与文档硬违例（跳过泛泛的代码风格挑刺）。
