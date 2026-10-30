import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import type { PlanEvidence } from "../../src/shared/assistant.js";
import { PlanningDriver, referenceFixture, toolReply } from "./planning-fixture.js";
import { source } from "./evolution-fixture.js";

type Input = {
  sources?: {id:string;text:string}[];
  materials?: {documents: (PlanEvidence & {content:unknown})[]};
  kind?: string;
  plan?: {workflowRules:{minLength:number}[];writableScope:string[];binding?:{materials:PlanEvidence[]}};
};
type History = {role?:string;parts?:{
  text?:string;
  functionResponse?:{name:string;response:{result:{ref?:string;content?:unknown;error?:string}}};
}[]}[];
const input = (text: string): Input => { try { return JSON.parse(text) as Input; } catch { return {}; } };

/** Stateless model decisions reconstructed from the native persisted provider history. Zero network. */
export class PlanningViewDriver implements Driver {
  requests: ModelRequest[] = [];
  constructor(private options: {inspectAfterRaw?:boolean;badViewCandidate?:boolean;invalidConclusion?:boolean} = {}) {}
  async generate(request: ModelRequest) {
    this.requests.push(structuredClone(request));
    const history=structuredClone(request.history) as History;
    const current=input(request.message??"{}");
    if(request.message && (current.sources && current.materials || current.kind==="candidate-task/1"))
      history.push({role:"user",parts:[{text:request.message}]});
    const inputs=history.flatMap(message=>(message.parts??[]).flatMap(part=>part.text?[input(part.text)]:[]));
    const responses=history.flatMap(message=>(message.parts??[]).flatMap(part=>part.functionResponse?[part.functionResponse]:[]));
    if(request.tools?.some(tool=>tool.name==="submit_candidate")) {
      const task=current.kind==="candidate-task/1"?current:inputs.findLast(value=>value.kind==="candidate-task/1");
      if(!task?.plan)throw new Error("fixture lost native candidate context");
      const minimum=task.plan.workflowRules[0]?.minLength??1;
      const viewBound=task.plan.binding?.materials.some(material=>material.source);
      const alreadyFailed=responses.some(response=>response.name==="submit_candidate"&&response.response.result.error);
      const content=this.options.badViewCandidate&&viewBound&&!alreadyFailed
        ? "const broken: string = 42; export default broken;"
        : source("default","轻快完成",minimum);
      const path=task.plan.writableScope.includes("active-source")?"active-source":"business/entry.ts";
      return {...toolReply("submit_candidate",{files:[{path,content}],members:[]}),history};
    }
    if(request.schema) return new PlanningDriver().generate(request);
    const seed=current.materials?current:inputs.findLast(value=>value.materials&&value.sources);
    if(!seed?.sources)throw new Error("fixture lost native planning context");
    const view=seed.materials?.documents.find(doc=>doc.source);
    const rawRead=responses.some(response=>response.name==="read_acceptance"&&response.response.result.ref===view?.source?.ref);
    if(view && !rawRead) return {...toolReply("read_acceptance",{ref:view.source!.ref}),history};
    if(view && this.options.invalidConclusion) return {...toolReply("propose_plan",{}),history};
    if(view && this.options.inspectAfterRaw && !responses.some(response=>response.name==="inspect_application"))
      return {...toolReply("inspect_application",{}),history};
    const minimum=seed.sources.at(-1)!.text.includes("至少三个字")?3:1;
    const finish={workflowRules:[{key:"reflection",label:"复盘",required:true,minLength:minimum,maxLength:5000}],
      ...(minimum===3?{acceptanceReason:"用户明确要求复盘至少三个字"}:{})};
    const reply=await new PlanningDriver(finish).generate({...request,message:JSON.stringify(seed),history});
    for(const call of reply.calls)
      if(call.name==="propose_plan")call.args=referenceFixture(call.args,seed.sources);
    return {...reply,history};
  }
}
