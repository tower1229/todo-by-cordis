/** Host-owned, versioned guidance. Index entries never imply delivery of content. */
import { executableMemberInterfaceDetails } from "./extensions/registry.js";
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
const detailedGuides = {
  "guide/command.register": `用途：辅助成员可通过 contribute().commands 注册任务动作，通过 contribute().fields 声明输入字段；宿主按声明呈现动作与输入表单。
限制：成员源码是独立模块，不导入工作流契约，不提供第二个工作流；只能修改冻结计划授权的成员。不得修改业务验收、系统保护约束或自行宣称验证通过。
接入：计划声明 memberAdditions 或 memberUpgrades、command.register 的提供者与消费方、成对的 memberCases；生成阶段提交对应 members[].source；宿主构建、运行隔离 Workspace 验收；用户先体验，再独立确认应用。
参考实现（新增 tags 辅助成员的完整源码）：
${tagsReferenceSource}
常见错误：遗漏 input-required 导致真实浏览器不出现表单；直接覆盖 task.fields 导致未知字段丢失；仅用冒烟代替正例和拒绝案例。
生命周期：未应用候选只在隔离体验中生效；应用确认后成员进入活动组合。必测：表单输入、首尾空格、空白拒绝、未知字段保留、体验隔离、独立应用。`,
  "guide/workflow.provide": `用途：主工作流通过 describe 和 decide 定义任务状态、动作和字段。限制：保留既有状态动作及未知 task.fields；只写冻结 business/* 范围，business/contract.ts 由宿主注入。接入：读取精确活动源码与契约，提交完整业务文件，宿主构建并以 workflow/1 冻结案例验证。常见错误：把缺失输入直接拒绝，或让 reopen 丢字段。生命周期：构建、隔离验收、体验、应用确认。必测：字段必填、Unicode 长度、重开和数据保留。`,
  "guide/schedule.register": `用途：业务成员注册在线定时动作。限制：依赖健康的宿主 schedule.runtime，离线不保证触发；没有时间检查器不得宣称完成定时需求。接入：读取宿主服务和成员契约，声明 schedule.register 与精确验收。常见错误：把宿主服务存在误当成已有业务定时任务。生命周期：成员启用时注册，停用或切换时取消。必测：触发时间、重启、停用和幂等。`,
} as const;

const sharedGuide = (purpose: string, limitations: string) =>
  `用途：${purpose}。限制：${limitations}；仅能修改冻结计划明确授权的业务成员，不得改变系统保护约束。接入：读取精确成员源码和契约，在计划中声明提供者、消费方和可写范围，提交完整成员源码。参考实现：见 guide/command.register 的可运行 tags 示例，并按当前接口契约替换贡献声明；不可把示例注释作为授权。常见错误：误以为声明等于宿主支持、遗漏受影响动作的冻结案例。生命周期：候选构建、隔离验收、体验、独立应用；成员停用后不再贡献。必测：注册状态、真实宿主行为、错误输入、数据保留与停用。`;

export const capabilityGuides: Record<string, string> = {
  ...Object.fromEntries(
    executableMemberInterfaceDetails.map((item) => [
      `guide/${item.id}`,
      sharedGuide(item.purpose, item.limitations),
    ]),
  ),
  ...detailedGuides,
};

export type CapabilityGuideRef = string;
export const capabilityGuideIndex = Object.keys(
  capabilityGuides,
) as CapabilityGuideRef[];
