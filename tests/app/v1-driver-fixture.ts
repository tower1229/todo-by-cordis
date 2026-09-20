import type { Driver } from "../../src/evolution/driver.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import {
  candidateScope,
  candidateSource,
  source,
} from "./evolution-fixture.js";
import { tagsTrimOnlyMemberCases } from "./member-case-fixtures.js";

const tagsSource = (lower: boolean, declareField: boolean) => `export default {
 contribute() { return {${declareField ? "fields:[{key:'tags',label:'标签',type:'text'}]," : ""}commands:[{id:'setTags',label:'设标签',from:['open','done']}]}; },
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

/** Only CI supplies implementations; never imported by the real-model entrypoint. */
export function v1FixtureDriver(
  syntheticCandidateFault = false,
  declareTagField = true,
): Driver {
  let phase = -1;
  let faultInjected = false;
  let planning: PlanningDriver;
  return {
    async generate(request) {
      if (!request.tools?.some((t) => t.name === "submit_candidate")) {
        if (!JSON.stringify(request.history).includes("inspect_application")) {
          phase++;
          const memberCases =
            phase === 0
              ? tagsTrimOnlyMemberCases
              : phase === 1
                ? [
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
                  ]
                : phase === 2
                  ? [
                      {
                        ...tagsTrimOnlyMemberCases[0],
                        expected: {
                          kind: "commit",
                          state: "open",
                          fields: { tags: "hello" },
                        },
                      },
                      tagsTrimOnlyMemberCases[1],
                    ]
                  : undefined;
          planning = new PlanningDriver({
            summary: [
              "标签",
              "计数",
              "标签小写",
              "完成前复盘",
              "停用标签",
              "启用标签",
            ][phase],
            ...(phase <= 2
              ? {
                  capabilityChanges: [
                    {
                      capability: "command.register",
                      provider: phase === 1 ? "member:counter" : "member:tags",
                      consumers: ["src/web/ActionForm.tsx"],
                      change: "成员命令变化",
                    },
                  ],
                }
              : {}),
            workflowRules:
              phase < 3
                ? []
                : [
                    {
                      key: "reflection",
                      label: "复盘",
                      required: true,
                      minLength: 1,
                      maxLength: 5000,
                    },
                  ],
            writableScope:
              phase >= 4 ? [] : phase > 0 ? candidateScope : ["active-source"],
            ...(phase < 2
              ? {
                  memberAdditions: [
                    {
                      pluginId: phase === 0 ? "tags" : "counter",
                      name: phase === 0 ? "标签插件" : "计数插件",
                    },
                  ],
                }
              : {}),
            ...(phase === 2
              ? {
                  memberUpgrades: [{ pluginId: "tags" }],
                  acceptanceReason: "用户要求标签统一小写",
                }
              : {}),
            ...(memberCases ? { memberCases } : {}),
            ...(phase >= 4
              ? { memberEnabled: { pluginId: "tags", enabled: phase === 5 } }
              : {}),
          });
        }
        return planning.generate(request);
      }
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
      if (phase >= 4) return reply("submit_candidate", { source: current });
      if (phase === 3)
        return reply(
          "submit_candidate",
          JSON.parse(candidateSource(source("default", "轻快完成"))),
        );
      if (phase > 0)
        return reply("submit_candidate", {
          ...(current.startsWith("{")
            ? JSON.parse(current)
            : {
                files: [
                  { path: "business/entry.ts", content: current },
                  {
                    path: "business/view.ts",
                    content: 'export default {title:"轻快完成",fields:[]};',
                  },
                  { path: "business/config.json", content: "{}" },
                  {
                    path: "business/compatibility.json",
                    content: '{"preserveUnknownFields":true}',
                  },
                ],
              }),
          members: [
            {
              pluginId: phase === 1 ? "counter" : "tags",
              source:
                phase === 1 ? counterSource : tagsSource(true, declareTagField),
            },
          ],
        });
      const inject = syntheticCandidateFault && !faultInjected;
      faultInjected = true;
      return reply("submit_candidate", {
        source:
          phase === 0
            ? `import type { Plugin } from './contract.js';
const plugin: Plugin = {
 describe: () => ({id:'default',name:'轻快完成',version:'1',initialState:'open',states:{open:{label:'未完成',category:'open'},done:{label:'已完成',category:'done'}},actions:[{id:'complete',label:'完成',from:['open']},{id:'reopen',label:'重新打开',from:['done']}],fields:[]}),
 decide({task,action}) {
 if ((action==='complete' && task.state==='open') || (action==='reopen' && task.state==='done')) return {kind:'commit',state:action==='complete'?'done':'open',fields:task.fields};
 return {kind:'reject',message:'不可用'};
 }
}; export default plugin;`
            : current,
        members: [
          {
            pluginId: phase === 1 ? "counter" : "tags",
            source: inject
              ? tagsSource(false, declareTagField).replace(".trim()", "")
              : tagsSource(false, declareTagField),
          },
        ],
      });
    },
  };
}
