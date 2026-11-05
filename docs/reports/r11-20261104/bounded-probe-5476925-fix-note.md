# bounded-probe-dad4a6f phase-2 冲突修复

提交：`5476925`
时间：2026-11-05
分支：`codex/model-interface-contraction`
PR：#52

## 失败现象

- 探针：bounded-probe-dad4a6f（round-5 Mac paid extended-ms）
- 阶段：phase-2 (counter) 规划
- 停止：planning-gate / plan-compilation
- 诊断：「同一字段验收义务发生冲突，初始状态或相同操作不能要求不同结果」
- Phase-0/1 已应用（tags 插件），phase-2 规划失败

## 根因定位

当添加新插件（counter）同时保留现有插件（tags）的派生字段时：

1. **canPreserve 路径**：`references.ts` line 537-538 识别出 tags 成员案例未变化，将 tags 派生字段放入 `canPreserve`
2. **投影生成**：line 539-546 调用 `deriveFieldObligations`，传入 `currentDefinitions`（所有当前需求的义务）作为 canonical 参数
3. **冲突产生**：如果 `currentDefinitions` 包含与 canPreserve 字段相同 member/field 的义务（可能来自其他需求的显式声明或隐式派生），`deriveFieldObligations` 会创建投影，该投影与 canPreserve 字段有**相同的 obligation.id** 但**不同的内容**（如 initialOrigin、scenarios 等）
4. **重复添加**：line 573 原逻辑 `replacement.obligations.push(...regenerated.filter(...), ...allRebound)` 将冲突的两个义务都添加到 replacement
5. **案例冲突**：line 629-639 生成浏览器案例时，两个义务生成相同 ID 的案例但内容不同，触发冲突检测

## 修复方案

在 `src/evolution/references.ts` line 573-579：

```typescript
// 修复前：
replacement.obligations.push(...regenerated.filter(o => o.kind !== "field" || !validatedRebound.includes(o)), ...allRebound);

// 修复后：
const allReboundIds = new Set(allRebound.map(o => o.id));
replacement.obligations.push(
  ...regenerated.filter(o => 
    (o.kind !== "field" || !validatedRebound.includes(o)) && !allReboundIds.has(o.id)
  ), 
  ...allRebound
);
```

**关键**：在添加 `regenerated` 时，不仅过滤掉 `validatedRebound` 中的字段义务，还要过滤掉与 `allRebound`（包括 `canPreserve`）有相同 ID 的所有义务，避免 ID 冲突。

## 验证

1. **回归测试**：新增 `tests/app/same-field-obligation-conflict.test.ts`，模拟 phase-2 添加 counter 同时保留 tags 的场景
2. **核心测试通过**：
   - acceptance-obligations.test.ts (7/7)
   - historical-preparation.test.ts (8/8)
   - field-reference-rebind.test.ts (15/15)
   - inherited-field-projection.test.ts (20/20)
3. **类型检查通过**：`pnpm typecheck`

## 后续行动

- 需在新提交上重跑 Mac paid extended-ms 探针，验证 phase-2 规划能否通过
- 如通过 phase-2，观察后续 phase-3/4/5 是否有新阻塞
- 保持 e655fee（宿主派生重绑定）、dad4a6f（browserCases 去重）、8b18866（历史最短路径）等修复不变

## 修复覆盖范围

此修复针对多插件并存场景下的字段义务冲突：
- ✅ 添加新插件时保留旧插件派生字段（canPreserve）
- ✅ 当前提案中有显式/隐式字段义务与 canPreserve 字段同 ID
- ✅ deriveFieldObligations 投影不与保留字段重复
- ⚠️ 不覆盖其他 planning-gate 停止原因（历史不唯一、browserCases 超限等已有修复）
