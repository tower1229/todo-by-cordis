import type { WorkflowRule } from "./assistant.js";
import type { BrowserCase, BrowserStep } from "./browser-cases.js";

/** All data samples and UI mechanics are host projections of frozen field rules.
 * No wording, selector, identity, or validation outcome is supplied by the model.
 */
export function workflowBrowserCases(
  id: string,
  rules: WorkflowRule[],
): BrowserCase[] {
  if (!rules.length) return [];
  if (
    rules.some(
      (r) =>
        !Number.isInteger(r.minLength) ||
        !Number.isInteger(r.maxLength) ||
        r.minLength < 0 ||
        r.maxLength < 1 ||
        r.maxLength * 2 > 10000 ||
        r.minLength > r.maxLength,
    )
  )
    throw new Error("工作流输入规则超出宿主表单可验证范围，需要维护者扩展");
  const input = Object.fromEntries(
    rules.map((r) => [r.key, "验".repeat(Math.max(1, r.minLength))]),
  );
  const cases: BrowserCase[] = [];
  const groups: BrowserStep[][] = [[]];
  const action = (values: Record<string, string>): BrowserStep => ({
    kind: "action",
    member: "workflow",
    action: "complete",
    input: values,
  });
  const error: BrowserStep = { kind: "error", text: "" };
  for (const r of rules) {
    const steps: BrowserStep[] = [];
    if (r.required) {
      steps.push({
        kind: "form-invalid",
        member: "workflow",
        action: "complete",
        field: r.key,
        input: { ...input, [r.key]: "" },
      });
      steps.push(action({ ...input, [r.key]: " " }), error);
    }
    if (r.minLength > 1)
      steps.push(
        action({ ...input, [r.key]: "验".repeat(r.minLength - 1) }),
        error,
      );
    steps.push(
      action({ ...input, [r.key]: "验".repeat(r.maxLength + 1) }),
      error,
    );
    const value = "😀".repeat(r.maxLength);
    const field: BrowserStep = {
      kind: "field",
      member: "workflow",
      contribution: "workflow",
      field: r.key,
      value,
    };
    steps.push(
      action({ ...input, [r.key]: value }),
      field,
      { kind: "action", member: "workflow", action: "reopen" },
      field,
    );
    if (groups.at(-1)!.length + steps.length > 40) groups.push([]);
    groups.at(-1)!.push(...steps);
  }
  for (const [index, steps] of groups.entries())
    for (const task of ["existing", "new"] as const)
      cases.push({
        id: `${id}-matrix-${index}-${task}`,
        task,
        steps,
        obligationId: id,
        classification: "frozen-business",
      });
  return cases;
}
