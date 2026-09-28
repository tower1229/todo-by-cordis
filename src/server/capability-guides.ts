/** Host-owned, versioned guidance. Index entries never imply delivery of content. */
export const tagsReferenceSource = `export default {
  contribute() { return { uiSlots: [{ id: "tag-detail", slot: "task.detail", title: "标签", fields: [{ key: "tags", label: "标签" }], actions: [{ commandId: "setTags", label: "编辑标签" }] }], fields: [{ key: "tags", label: "标签", type: "text" }], commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }] }; },
  decide({ task, action, input }) {
    if (action !== "setTags") return { kind: "reject", message: "未知动作" };
    if (!Object.hasOwn(input, "tags")) return { kind: "input-required", fields: [{ key: "tags", label: "标签", type: "text", required: true }] };
    const tags = String(input.tags).trim();
    if (!tags) return { kind: "reject", message: "标签为空" };
    return { kind: "commit", state: task.state, fields: { ...task.fields, tags } };
  }
};`;
export const tagsEventUpgradeSource = `const createdEvents = new Map();
export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }, { key: "createdSeen", label: "创建事件", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }, { id: "confirmCreated", label: "确认创建事件", from: ["open", "done"] }],
      events: ["task.created"],
      uiSlots: [{ id: "tag-detail", slot: "task.detail", title: "标签与事件", fields: [{ key: "tags", label: "标签" }, { key: "createdSeen", label: "创建事件" }], actions: [{ commandId: "setTags", label: "编辑标签" }, { commandId: "confirmCreated", label: "确认创建事件" }] }],
    };
  },
  onTaskEvent({ kind, task }) {
    if (kind === "task.created") createdEvents.set(task.id, (createdEvents.get(task.id) ?? 0) + 1);
  },
  decide({ task, action, input }) {
    if (action === "setTags") {
      if (!Object.hasOwn(input, "tags")) return { kind: "input-required", fields: [{ key: "tags", label: "标签", type: "text", required: true }] };
      const tags = String(input.tags).trim().toLowerCase();
      if (!tags) return { kind: "reject", message: "标签为空" };
      return { kind: "commit", state: task.state, fields: { ...task.fields, tags } };
    }
    if (action === "confirmCreated") {
      if (task.state !== "open") return { kind: "reject", message: "仅未完成任务可确认创建事件" };
      if (createdEvents.get(task.id) !== 1) return { kind: "reject", message: "未收到唯一创建事件" };
      return { kind: "commit", state: task.state, fields: { ...task.fields, createdSeen: "1" } };
    }
    return { kind: "reject", message: "未知动作" };
  },
};`;
const detailedGuides = {
  "guide/command.register": `用途：辅助成员可通过 contribute().commands 注册任务动作，通过 contribute().fields 声明输入字段；宿主按声明呈现动作与输入表单。
限制：成员源码是独立模块，不导入工作流契约，不提供第二个工作流；只能修改冻结计划授权的成员。不得修改业务验收、系统保护约束或自行宣称验证通过。
接入：计划声明 memberAdditions 或 memberUpgrades、command.register 的提供者与消费方、成对的 memberCases；生成阶段提交对应 members[].source；宿主构建、运行隔离 Workspace 验收；用户先体验，再独立确认应用。
参考实现（新增 tags 辅助成员的完整源码）：
${tagsReferenceSource}
常见错误：遗漏 input-required 导致真实浏览器不出现表单；直接覆盖 task.fields 导致未知字段丢失；仅用冒烟代替正例和拒绝案例。
生命周期：未应用候选只在隔离体验中生效；应用确认后成员进入活动组合。必测：表单输入、首尾空格、空白拒绝、未知字段保留、体验隔离、独立应用。`,
  "guide/task.events": `用途：辅助成员可在 contribute().events 中只登记 task.created、task.updated 或 task.deleted，由宿主在成功提交后派发 onTaskEvent({kind,task,changedPaths,revision,source})。事件观察者失败只记诊断，不回滚已提交任务；回调不可直接修改任务或写数据库。
受限范式：仅订阅 task.created，在成员实例的内存 Map 中按 task.id 记录收到次数；用户点确认创建事件动作时，decide 只在当前任务恰好收到一次创建事件时把 createdSeen="1" 写入任务字段。停用或切换版本销毁旧实例；新实例不补发停用期间的事件。不得借事件回调直接写库、调用任意 IO、引入调度引擎或修改宿主保护机制。
升级既有 tags：先读取 member-source、member-contract、member-acceptance 的精确 versionId；沿用历史案例 name 修订小写预期并给出 acceptanceReason，保留其他成员精确版本。新增 confirmCreated 的成功与拒绝成对 memberCases；成功案例在隔离 Workspace 创建任务后执行动作，预期 createdSeen="1"，因此重复派发会被拒绝。完整参考源码：
${tagsEventUpgradeSource}
浏览器验收：需求与指南、候选完整组合体验、独立应用、标签与计数共存、启停及撤回后的任务数据和事件效果。模型桩与真实模型调用分别标记。`,
  "guide/workflow.provide": `用途：主工作流通过 describe 和 decide 定义任务状态、动作和字段。限制：保留既有状态动作及未知 task.fields；只写冻结 business/* 范围，business/contract.ts 由宿主注入。接入：读取精确活动源码与契约，提交完整业务文件，宿主构建并以 workflow/1 冻结案例验证。可运行参考实现：本轮 inspect_application 已发送的 active-source 是当前正式工作流的完整源码；以 read_current_source 获取执行期的精确版本，结合 active-contract 和冻结案例改动，不能照搬旧版以冒充新要求通过。常见错误：把缺失输入直接拒绝，或让 reopen 丢字段。生命周期：构建、隔离验收、体验、应用确认。必测：字段必填、Unicode 长度、重开和数据保留。`,
} as const;
export const capabilityGuides: Record<string, string> = detailedGuides;

export type CapabilityGuideRef = string;
export const capabilityGuideIndex = Object.keys(
  capabilityGuides,
) as CapabilityGuideRef[];
