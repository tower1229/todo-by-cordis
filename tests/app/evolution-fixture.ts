import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
export function source(pluginId: string, name = "Reflection", minimum = 1) {
  return `import type { Plugin } from './contract.js';
const plugin: Plugin = {
 describe: () => ({id:${JSON.stringify(pluginId)},name:${JSON.stringify(name)},version:'1',initialState:'open',states:{open:{label:'未完成',category:'open'},done:{label:'已完成',category:'done'}},actions:[{id:'complete',label:'完成',from:['open']},{id:'reopen',label:'重新打开',from:['done']}],fields:[{key:'reflection',label:'复盘',type:'text',required:true}]}),
 decide({task,action,input}) {
  if ((action==='complete' && task.state!=='open') || (action==='reopen' && task.state!=='done') || !['complete','reopen'].includes(action)) return {kind:'reject',message:'不可用'};
  if(action==='reopen') return {kind:'commit',state:'open',fields:task.fields};
  const value=input.reflection?.trim();
  if(!value) return {kind:'input-required',fields:plugin.describe().fields};
  if([...value].length<${minimum} || [...value].length>5000) return {kind:'reject',message:'复盘字数不符合要求'};
  return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};
 }
}; export default plugin;`;
}
export const proposal = (modify = false, pluginId = "", minimum = 1) => ({
  route: modify ? "modify-plugin" : "create-plugin",
  pluginId,
  name: "Reflection",
  summary: "完成前复盘",
  changes: [`复盘至少${minimum}字`],
  outcome: "完成时填写复盘",
  dataImpact: "保留已有数据",
  fields: [
    {
      key: "reflection",
      label: "复盘",
      required: true,
      minLength: minimum,
      maxLength: 5000,
    },
  ],
});
export class FixtureDriver implements Driver {
  requests: ModelRequest[] = [];
  constructor(
    public planning: unknown = proposal(),
    public generateSource = source,
  ) {}
  async generate(request: ModelRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    this.requests.push(request);
    if (request.schema)
      return {
        text: JSON.stringify(this.planning),
        history: [],
        calls: [],
        usage: null,
        raw: { fixture: true },
      };
    const body = JSON.parse(request.message ?? "{}");
    const target = body.target?.payload;
    if (!target) throw new Error("fixture exhausted");
    return {
      text: "",
      history: [
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "submit_candidate", args: {} },
              thoughtSignature: "fixture",
            },
          ],
        },
      ],
      calls: [
        {
          name: "submit_candidate",
          args: {
            source: this.generateSource(
              target.pluginId,
              target.name,
              target.fields[0].minLength,
            ),
          },
        },
      ],
      usage: null,
      raw: { fixture: true },
    };
  }
}
