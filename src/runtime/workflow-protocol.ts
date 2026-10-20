import type { Plugin, WorkflowDecision } from "../server/business/contracts.js";
import type { WorkflowProtocolProfile } from "../shared/workflow-protocol.js";

type Input = Parameters<Plugin["decide"]>[0];

/** Standard workflow protocol; custom business decisions still cross the VM seam. */
export function hostWorkflowService(
  service: Record<string, unknown>,
  profile: WorkflowProtocolProfile,
): Record<string, unknown> {
  if (profile.version !== "host-workflow/1")
    throw new Error("不支持的宿主工作流协议版本");
  const { definition, rules } = structuredClone(profile);
  const fields = rules.map(({ key, label, required }) => ({
    key,
    label,
    type: "text" as const,
    required,
  }));
  const business = (data: Input): WorkflowDecision | undefined => {
    if (
      !Object.hasOwn(service, "decide") ||
      typeof service.decide !== "function"
    )
      return undefined;
    const result: unknown = service.decide(data);
    if (result === undefined) return undefined;
    if (
      !result ||
      typeof result !== "object" ||
      !["commit", "reject", "input-required"].includes(
        String((result as Record<string, unknown>).kind),
      )
    )
      throw new Error("业务决策结构无效");
    return result as WorkflowDecision;
  };
  const reject = (message: string, data: Input): WorkflowDecision => {
    const custom = business(data);
    return custom?.kind === "reject" ? custom : { kind: "reject", message };
  };
  return {
    ...service,
    describe: () => structuredClone(definition),
    decide(data: Input): WorkflowDecision {
      const { task, action, input } = data;
      const declared = definition.actions.find((a) => a.id === action);
      if (!declared?.from.includes(task.state))
        return reject("当前状态不能执行此操作", data);
      const normalized = { ...input };
      if (action === "complete") {
        for (const rule of rules)
          if (Object.hasOwn(input, rule.key))
            normalized[rule.key] = input[rule.key].trim();
        if (rules.some((rule) => rule.required && !normalized[rule.key]))
          return { kind: "input-required", fields: structuredClone(fields) };
        for (const rule of rules) {
          if (!Object.hasOwn(normalized, rule.key)) continue;
          const length = [...normalized[rule.key]].length;
          if (
            (length < rule.minLength &&
              (rule.required || rule.minLength > 1)) ||
            length > rule.maxLength
          )
            return reject(`${rule.label}字数不符合要求`, {
              ...data,
              input: normalized,
            });
        }
      }
      const custom = business({ ...data, input: normalized });
      if (custom !== undefined) return custom;
      if (action === "complete") {
        if (rules.some((rule) => !Object.hasOwn(input, rule.key)))
          return { kind: "input-required", fields: structuredClone(fields) };
        return {
          kind: "commit",
          state: "done",
          fields: {
            ...task.fields,
            ...Object.fromEntries(
              rules
                .filter((r) => Object.hasOwn(normalized, r.key))
                .map((r) => [r.key, normalized[r.key]]),
            ),
          },
        };
      }
      if (action === "reopen")
        return { kind: "commit", state: "open", fields: { ...task.fields } };
      return { kind: "reject", message: "业务动作尚未实现" };
    },
  };
}
