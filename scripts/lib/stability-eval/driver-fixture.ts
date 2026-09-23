import type { Driver, ModelRequest } from "../../../src/evolution/driver.js";
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

const tagsSource = (lower: boolean) => `export default {
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
    writableScope: ["active-source"],
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
  return {
    async generate(request: ModelRequest) {
      if (!request.tools?.some((t) => t.name === "submit_candidate")) {
        if (!JSON.stringify(request.history).includes("inspect_application")) {
          planning = new PlanningDriver(planFinish(scenarioId));
        }
        return (planning ?? new PlanningDriver()).generate(request);
      }
      return submitCandidate(scenarioId, request);
    },
  };
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

function submitCandidate(scenarioId: string, request: ModelRequest) {
  const history = request.history as {
    parts?: {
      functionResponse?: {
        name: string;
        response: { result: { source?: string } };
      };
    }[];
  }[];
  const responses = history
    .flatMap((m) => m.parts ?? [])
    .flatMap((p) => (p.functionResponse ? [p.functionResponse] : []));
  const reply = (name: string, args: Record<string, unknown>) => ({
    ...toolReply(name, args),
    history: request.history,
  });
  if (!responses.some((r) => r.name === "read_contract"))
    return reply("read_contract", {});
  const current = responses.find((r) => r.name === "read_current_source")
    ?.response.result.source;
  if (!current) return reply("read_current_source", {});

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

  // tags-add: keep a stable default workflow source plus the new member.
  return reply("submit_candidate", {
    source: `import type { Plugin } from './contract.js';
const plugin: Plugin = {
 describe: () => ({id:'default',name:'轻快完成',version:'1',initialState:'open',states:{open:{label:'未完成',category:'open'},done:{label:'已完成',category:'done'}},actions:[{id:'complete',label:'完成',from:['open']},{id:'reopen',label:'重新打开',from:['done']}],fields:[]}),
 decide({task,action}) {
 if ((action==='complete' && task.state==='open') || (action==='reopen' && task.state==='done')) return {kind:'commit',state:action==='complete'?'done':'open',fields:task.fields};
 return {kind:'reject',message:'不可用'};
 }
}; export default plugin;`,
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

export function stabilityDriverFor(scenarioId: string): Driver {
  if (scenarioId === "due-auto-expire") return dueBaselineStubDriver();
  return stabilityStubDriver(scenarioId);
}
