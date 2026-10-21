import type { Driver, ModelRequest } from "../../../src/evolution/driver.js";
import { DeltaFixture } from "../../../tests/app/evolution-adapter.js";
import {
  PlanningDriver,
  toolReply,
} from "../../../tests/app/planning-fixture.js";
import {
  candidateScope,
  source,
} from "../../../tests/app/evolution-fixture.js";
import {
  tagsMemberCases,
  tagsTrimOnlyMemberCases,
} from "../../../tests/app/member-case-fixtures.js";
import type { StabilityScenario } from "./manifest.js";
import { dueAutoExpireSource } from "../../../src/server/capability-guides.js";

const tagsSource = (lower: boolean) =>
  `export default {
 contribute() { return {uiSlots:[{id:'tag-detail',slot:'task.detail',title:'标签',fields:[{key:'tags',label:'标签'}],actions:[{commandId:'setTags',label:'编辑标签'}]}],fields:[{key:'tags',label:'标签',type:'text'}],commands:[{id:'setTags',label:'设标签',from:['open','done']}]}; },
 decide({task,action,input}) {
  if(action!=='setTags') return {kind:'reject',message:'未知动作'};
  if(!Object.hasOwn(input??{},'tags'))return {kind:'input-required',fields:[{key:'tags',label:'标签',type:'text',required:true}]};
  const tags=String(input?.tags ?? '').trim()${lower ? ".toLowerCase()" : ""};
  if(!tags) return {kind:'reject',message:'标签为空'};
  return {kind:'commit',state:task.state,fields:{...task.fields,tags}};
 }
};`;

const counterSource = `export default {
 contribute() { return {fields:[{key:'count',label:'计数',type:'text'}],commands:[{id:'increment',label:'加一',from:['open']}]}; },
 decide({task,action}) {
  if(action!=='increment'||task.state!=='open') return {kind:'reject',message:'不可用'};
  return {kind:'commit',state:task.state,fields:{...task.fields,count:String(Number(task.fields.count??'0')+1)}};
 }
};`;

function memberPlan(
  summary: string,
  pluginId: string,
  name: string,
  memberCases: unknown[],
  upgrades = false,
): ConstructorParameters<typeof PlanningDriver>[0] {
  return {
    summary,
    workflowRules: [],
    capabilityChanges: [
      {
        capability: "command.register",
        provider: `member:${pluginId}`,
        consumers: ["src/web/ActionForm.tsx"],
        change: upgrades ? "升级成员" : "新增成员",
      },
    ],
    writableScope: [],
    ...(upgrades
      ? {
          memberUpgrades: [{ pluginId }],
          acceptanceReason: "用户要求升级既有成员行为",
          memberCases,
        }
      : {
          memberAdditions: [{ pluginId, name }],
          memberCases,
        }),
  };
}

/** CI model stubs only — never imported by the authorized real-model entry path for generation. */
export function stabilityStubDriver(scenarioId: string): Driver {
  let planning: PlanningDriver | undefined;
  let current = "";
  return new DeltaFixture({
    async generate(request: ModelRequest) {
      if (request.schema && planning) return planning.generate(request);
      if (!request.tools?.some((t) => t.name === "submit_candidate")) {
        if (!JSON.stringify(request.history).includes("inspect_application")) {
          planning = new PlanningDriver(planFinish(scenarioId));
        }
        return (planning ?? new PlanningDriver()).generate(request);
      }
      const documents = JSON.parse(request.message ?? "{}").materials
        ?.documents as { ref: string; content: unknown }[] | undefined;
      const delivered = documents?.find(
        (d) => d.ref === "active-source",
      )?.content;
      if (typeof delivered === "string") current = delivered;
      if (!current) throw new Error("missing frozen active source");
      return submitCandidate(scenarioId, request, current);
    },
  });
}

function planFinish(
  scenarioId: string,
): ConstructorParameters<typeof PlanningDriver>[0] {
  switch (scenarioId) {
    case "tags-add":
      return memberPlan("新增标签插件", "tags", "标签插件", [
        ...tagsTrimOnlyMemberCases,
        {
          ...tagsTrimOnlyMemberCases[1],
          name: "缺失标签输入",
          input: {},
        },
      ]);
    case "counter-add":
      return memberPlan("新增计数插件", "counter", "计数插件", [
        {
          name: "计数增加",
          member: "counter",
          state: "open",
          fields: { count: "7" },
          action: "increment",
          input: {},
          expected: {
            kind: "commit",
            state: "open",
            fields: { count: "8" },
          },
        },
        {
          name: "完成后拒绝计数",
          member: "counter",
          state: "done",
          fields: {},
          action: "increment",
          input: {},
          expected: { kind: "reject" },
        },
      ]);
    case "member-upgrade-tags":
      return memberPlan(
        "升级标签为小写",
        "tags",
        "标签插件",
        tagsMemberCases,
        true,
      );
    case "rule-revision-reflection":
      return {
        summary: "完成前填写复盘",
        workflowRules: [
          {
            key: "reflection",
            label: "复盘",
            required: true,
            minLength: 1,
            maxLength: 5000,
          },
        ],
        acceptanceReason: "用户要求完成前必填复盘",
        writableScope: ["active-source"],
      };
    case "due-auto-expire":
      throw new Error(
        "due-auto-expire 必须走 dueBaselineStubDriver，不得经 planFinish",
      );
    case "missing-capability-push":
      return {
        summary: "外部推送通知",
        outcome: "外部推送尚不可用",
        unresolved: [
          "因不能真实调用外部 IO 及通知交付，离线保证送达需要维护者能力，当前不能自行完成",
        ],
        writableScope: candidateScope,
        capabilityChanges: [
          {
            capability: "notification-delivery",
            provider: "business/notify.ts",
            consumers: [],
            change: "外部推送能力确实缺失",
          },
        ],
      };
    case "temporarily-unavailable-dependency":
      return {
        summary: "可选提醒时间字段",
        outcome: "环境依赖不可用时不能开始",
        writableScope: candidateScope,
        capabilityChanges: [
          {
            capability: "workflow",
            provider: "active-source",
            consumers: ["src/web/ActionForm.tsx"],
            change: "仅记录提醒时间",
          },
        ],
        workflowRules: [
          {
            key: "reminderTime",
            label: "提醒时间",
            required: false,
            minLength: 0,
            maxLength: 64,
          },
        ],
      };
    default:
      throw new Error(`未知稳定性评估场景：${scenarioId}`);
  }
}

function submitCandidate(
  scenarioId: string,
  request: ModelRequest,
  current: string,
) {
  const reply = (name: string, args: Record<string, unknown>) => ({
    ...toolReply(name, args),
    history: request.history,
  });
  if (scenarioId === "rule-revision-reflection")
    return reply("submit_candidate", {
      source: source("default", "轻快完成"),
    });

  if (scenarioId === "counter-add" || scenarioId === "member-upgrade-tags") {
    const memberSource =
      scenarioId === "counter-add" ? counterSource : tagsSource(true);
    const pluginId = scenarioId === "counter-add" ? "counter" : "tags";
    if (current.startsWith("{")) {
      return reply("submit_candidate", {
        files: (
          JSON.parse(current) as {
            files: { path: string; content: string }[];
          }
        ).files,
        members: [{ pluginId, source: memberSource }],
      });
    }
    return reply("submit_candidate", {
      source: current,
      members: [{ pluginId, source: memberSource }],
    });
  }

  // Auxiliary additions inherit the exact baseline under the delta protocol.
  return reply("submit_candidate", {
    source: current,
    members: [{ pluginId: "tags", source: tagsSource(false) }],
  });
}

/**
 * Due-date stub mirrors current planning instruction: clarify first, then block.
 * Not a success fixture — baseline records the existing blocker.
 */
export function dueBaselineStubDriver(): Driver {
  let clarified = false;
  const planning = new PlanningDriver({
    summary: "可选截止时间与到期过期",
    outcome: "当前环境将定时调度报告为技术阻塞",
    unresolved: [
      "因不能真实调用外部 IO 及系统缺少定时提醒调度基础环境，到时间自动过期将被报告为技术阻塞，等待维护者后续推进",
    ],
    writableScope: candidateScope,
    capabilityChanges: [
      {
        capability: "timer-scheduling",
        provider: "business/scheduler.ts",
        consumers: [],
        change: "当前提示词仍将定时需求导向维护者能力",
      },
    ],
  });
  return {
    async generate(request) {
      if (request.schema && planning) return planning.generate(request);
      if (request.tools?.some((t) => t.name === "submit_candidate"))
        throw new Error("截止时间基线场景不得生成候选实现");
      const history = JSON.stringify(request.history);
      if (!history.includes("inspect_application"))
        return toolReply("inspect_application", {});
      if (!clarified && !history.includes("request_clarification")) {
        clarified = true;
        return {
          ...toolReply("request_clarification", {
            question:
              "完整到点自动过期需要定时调度。可改为只记录可选截止时间，或坚持完整能力并等待维护者补齐？",
          }),
          history: request.history,
        };
      }
      return planning.generate(request);
    },
  };
}

export function stabilityDriverFor(
  scenarioId: string,
  scenario?: StabilityScenario,
): Driver {
  if (scenario?.oracle?.kind === "block" && scenario.oracle.reason === "offline-delivery")
    return { async generate(request) {
      const input = JSON.parse(request.message ?? "{}");
      const value = input.kind === "request-admission/2" ? {
        effects: [
          { source: 1, sourceQuote: "向外部推送通知", effect: "external-delivery" },
          { source: 1, sourceQuote: "离线时仍保证送达", effect: "offline-delivery" },
        ], initials: [], questions: [],
      } : input.kind === "admission-source-review/2" ? { decisions: input.claims.map((c: {sourceQuote:string}, i:number) => ({
        claim: i + 1, source: 1, sourceQuote: c.sourceQuote, layer: "capability", verdict: "entailed", detail: "合成需求明确要求宿主不支持的外部和离线交付",
      })) } : undefined;
      if (!value) throw new Error("交付边界模型桩不得进入业务规划或生成");
      return { text: JSON.stringify(value), calls: [], history: [], usage: null, raw: {fixture:"current-delivery-boundary"} };
    } };
  if (scenario?.oracle && scenarioId === "due-auto-expire")
    return dueCurrentStubDriver();
  if (scenarioId === "clarification-reflection") {
    const original = stabilityStubDriver("rule-revision-reflection");
    return {
      async generate(request, signal, onTransport) {
        const input = JSON.parse(request.message ?? "{}") as {
          kind?: string; sources?: { text: string }[]; questions?: string[];
        };
        const quote = scenario?.clarification?.sourceQuote ?? "复盘是否必填尚未决定";
        const value = input.kind === "request-admission/2" ? {
          initials: [], effects: [],
          questions: input.sources?.some(s => s.text === scenario?.clarification?.answer) ? [] :
            [{ source: 1, sourceQuote: quote, choice: {kind:"field-required"} }],
        } : input.kind === "clarification-review/2" ? {
          effects: ["external-delivery", "offline-delivery", "online-schedule"].map(effect => ({ effect, verdict: "not-requested" })),
          decisions: (input.questions ?? []).map(() => ({ kind: "business-ambiguity", source: 1,
            sourceQuote: quote, detail: "模型桩仅审查需求明确未决定的复盘必填性" })),
        } : undefined;
        if (value) {
          return { text: JSON.stringify(value), calls: [], history: [], usage: null,
            raw: { fixture: "source-bound-clarification" } };
        }
        return original.generate(request, signal, onTransport);
      },
    };
  }
  if (scenarioId === "unsupported-blank-presentation")
    return {
      async generate(request) {
        const input = JSON.parse(request.message ?? "{}") as {
          kind?: string;
          sources?: { text: string }[];
          claims?: { sourceQuote: string }[];
        };
        let value: unknown;
        if (input.kind === "request-admission/2")
          value = {
            effects: [], initials: [
              {
                source: 1,
                sourceQuote: "尚未填写时显示空白",
                target: { kind: "new", name: "评审备注" },
                meaning: {
                  kind: "blank",
                  conditionQuote: "尚未填写时",
                  effectQuote: "显示空白",
                },
              },
            ],
            questions: [],
          };
        else if (input.kind === "admission-source-review/2")
          value = {
            decisions: input.claims!.map((c, i) => ({
              claim: i + 1,
              source: 1,
              sourceQuote: c.sourceQuote,
              layer: "initial-display", verdict: "entailed",
              detail: "合成需求明确要求尚未填写显示空白",
            })),
          };
        else throw new Error("空白呈现边界桩不得进入规划或生成");
        return {
          text: JSON.stringify(value),
          history: [],
          calls: [],
          usage: null,
          raw: { fixture: "current-blank-boundary" },
        };
      },
    };
  if (scenarioId === "due-auto-expire") return dueBaselineStubDriver();
  return stabilityStubDriver(scenarioId);
}

/** Reference output only for evaluator CI. Never selected by a real-model run. */
function dueCurrentStubDriver(): Driver {
  const at = new Date(Date.now() + 600000).toISOString();
  const planning = new PlanningDriver({
    summary: "可选截止时间与在线自动过期",
    workflowRules: [],
    memberAdditions: [{ pluginId: "due", name: "截止时间" }],
    memberCases: [
      {
        name: "设置截止",
        member: "due",
        state: "open",
        fields: {},
        action: "setDue",
        input: { dueAt: at },
        expected: { kind: "commit", state: "open", fields: { dueAt: at } },
      },
      {
        name: "拒绝无效日期",
        member: "due",
        state: "open",
        fields: {},
        action: "setDue",
        input: { dueAt: "invalid" },
        expected: { kind: "reject" },
      },
      {
        name: "到期标记",
        member: "due",
        state: "open",
        fields: { dueAt: at },
        action: "expire",
        input: { scheduledAt: at },
        expected: {
          kind: "commit",
          state: "open",
          fields: { dueAt: at, expired: "true" },
        },
      },
      {
        name: "完成后拒绝过期",
        member: "due",
        state: "done",
        fields: { dueAt: at },
        action: "expire",
        input: { scheduledAt: at },
        expected: { kind: "reject" },
      },
      {
        name: "修改已过期截止清除标记", member: "due", state: "open",
        fields: { dueAt: "2030-01-01T00:00:00Z", expired: "true" }, action: "setDue", input: { dueAt: at },
        expected: { kind: "commit", state: "open", fields: { dueAt: at } },
      },
      {
        name: "清除已过期截止与标记", member: "due", state: "open",
        fields: { dueAt: at, expired: "true" }, action: "setDue", input: { dueAt: "" },
        expected: { kind: "commit", state: "open", fields: {} },
      },
    ],
    capabilityChanges: [
      {
        capability: "command.register",
        provider: "member:due",
        consumers: ["src/web/ActionForm.tsx"],
        change: "截止表单与过期动作",
      },
      {
        capability: "schedule.register",
        provider: "member:due",
        consumers: ["src/web/WorkspacePanel.tsx"],
        change: "在线调度",
      },
    ],
    requiredCapabilities: [
      { interfaceId: "schedule.runtime", providerId: "host:online-scheduler" },
    ],
  });
  return new DeltaFixture({
    async generate(request, signal) {
      if (request.tools?.some((t) => t.name === "submit_candidate")) {
        const docs = JSON.parse(request.message ?? "{}").materials
          ?.documents as { ref: string; content: unknown }[];
        const current = docs.find((d) => d.ref === "active-source")?.content;
        if (typeof current !== "string") throw new Error("缺少冻结源码");
        return {
          ...toolReply("submit_candidate", {
            source: current,
            members: [{ pluginId: "due", source: dueAutoExpireSource }],
          }),
          history: request.history,
        };
      }
      const reply = await planning.generate(request);
      if (
        reply.calls.some((c) => c.name === "propose_plan") &&
        !JSON.stringify(request.history).includes("read_guides")
      )
        return {
          ...toolReply("read_guides", { refs: ["guide/schedule.register"] }),
          history: request.history,
        };
      return reply;
    },
  });
}
