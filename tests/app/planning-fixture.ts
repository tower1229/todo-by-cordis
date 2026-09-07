import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
export const toolReply = (name: string, args: Record<string, unknown>) => ({
  text: "",
  history: [],
  calls: [{ name, args }],
  usage: null,
  raw: { fixture: true },
});
export class PlanningDriver implements Driver {
  requests: ModelRequest[] = [];
  constructor(public finish: Record<string, unknown> = {}) {}
  async generate(request: ModelRequest) {
    this.requests.push(request);
    const toolReply = (name: string, args: Record<string, unknown>) => ({
      text: "",
      history: request.history,
      calls: [{ name, args }],
      usage: null,
      raw: { fixture: true },
    });
    const rules = [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 5000,
      },
    ];
    const content = JSON.stringify(request.history);
    if (!content.includes("inspect_application"))
      return toolReply("inspect_application", {});
    if (!content.includes("read_source"))
      return {
        ...toolReply("read_source", { ref: "active-source" }),
        calls: [
          { name: "read_source", args: { ref: "active-source" } },
          { name: "read_source", args: { ref: "src/web/ActionForm.tsx" } },
          { name: "read_contract", args: { ref: "src/shared/contracts.ts" } },
          {
            name: "read_acceptance",
            args: { ref: "src/server/evolution-domain.ts" },
          },
          { name: "check_environment", args: {} },
          { name: "read_contract", args: { ref: "active-contract" } },
          { name: "read_acceptance", args: { ref: "active-acceptance" } },
          { name: "describe_verification", args: { rules } },
        ],
      };
    const messages = request.history as {
      parts: {
        functionResponse?: {
          response: {
            result: {
              ref?: string;
              hash?: string;
              content?: { cases: unknown[] };
            };
          };
        };
      }[];
    }[];
    const evidence = messages
      .flatMap((m) => m.parts ?? [])
      .flatMap((p) =>
        p.functionResponse?.response.result.ref
          ? [
              {
                ref: p.functionResponse.response.result.ref,
                hash: p.functionResponse.response.result.hash,
              },
            ]
          : [],
      );
    return toolReply("propose_plan", {
      summary: "完成任务前填写复盘",
      changes: ["完成前要求填写复盘"],
      outcome: "未填写复盘不能完成任务",
      dataImpact: "保留历史任务及未知字段",
      excluded: ["不修改其他动作"],
      capabilityChanges: [
        {
          capability: "workflow",
          provider: "active-source",
          consumers: ["src/web/ActionForm.tsx"],
          change: "增加复盘字段",
        },
      ],
      workflowRules: rules,
      acceptance: messages
        .flatMap((m) => m.parts ?? [])
        .find(
          (p) =>
            p.functionResponse?.response.result.ref ===
            "verification-definition",
        )?.functionResponse?.response.result.content?.cases,
      steps: [
        {
          id: "workflow",
          purpose: "调整完成行为",
          dependsOn: [],
          artifact: "工作流候选",
          evidence: "工作流验收报告",
        },
      ],
      writableScope: ["active-source"],
      compatibility: "保留未知字段",
      rollback: "撤回实现，保留当前任务数据",
      preview: "隔离合成任务表单",
      application: "用户另行确认后切换工作流",
      restartImpact: "重启业务子进程，短暂停写",
      dependencies: [],
      unresolved: [],
      evidence,
      ...this.finish,
    });
  }
}
