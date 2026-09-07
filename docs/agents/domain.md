# Domain Docs

本项目采用单领域布局。探索和编写规格前，读取根目录 `CONTEXT.md`，沿用其中的领域术语；读取 `docs/adr/` 中与任务相关的决策。文件缺失时正常继续，不为占位而创建。

不要把词汇表当作实现规格或工作笔记。新术语需要澄清后再由 domain-modeling 记录；遇到 ADR 冲突应明确指出，不静默覆盖。

当前 Agent 重构的完整设计为 `docs/engineering/06-agent-redesign.md`。历史 PRD 和工程文档中的冲突规则按该设计及已接受的 ADR 覆盖；历史测试报告不代替新改动验收。
