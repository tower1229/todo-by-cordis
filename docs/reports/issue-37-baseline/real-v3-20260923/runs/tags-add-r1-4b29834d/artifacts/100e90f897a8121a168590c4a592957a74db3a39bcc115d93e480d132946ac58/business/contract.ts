// Plugin below is the primary workflow contract. Auxiliary members are self-contained modules,
// not workflow Plugins: export contribute/decide as needed, without describe or imports.
// This contract file is supplied only to workflow files, never to members[].source.
export type Task = { id:string; title:string; description:string; state:string; revision:number; createdAt:string; updatedAt:string; deletedAt:string|null; fields:Record<string,string> };
export type Field = { key:string; label:string; type:"text"; required?:boolean; description?:string };
export type WorkflowDefinition = { id:string; name:string; version:string; initialState:string; states:Record<string,{label:string;category:"open"|"done"}>; actions:{id:string;label:string;from:string[]}[]; fields:Field[] };
export type WorkflowDecision = {kind:"reject";message:string}|{kind:"input-required";fields:Field[]}|{kind:"commit";state:string;fields:Record<string,string>};
export type Workflow = { definition: WorkflowDefinition; decide(task:Task,action:string,input:Record<string,string>):WorkflowDecision };
export type MissPolicy = "skip"|"run-once";
export type TaskEventKind = "task.created"|"task.updated"|"task.deleted";
export type ExtensionContribution = {
  commands?:{id:string;label:string;from?:string[]}[];
  fields?:Field[];
  beforeCommit?:boolean;
  events?:TaskEventKind[];
  schedules?:{id:string;at:string;atKind?:"absolute"|"field";timezone?:string;dedupeKey:string;onFire:{type:"action";commandId:string;taskId?:string;input?:Record<string,string>};missPolicy:MissPolicy}[];
  lifecycle?:{activate?:boolean;ready?:boolean;quiesce?:boolean;dispose?:boolean};
  uiSlots?:{id:string;slot:"task.detail";title:string;body?:string;actions?:{commandId:string;label:string}[];fields?:{key:string;label:string}[];order?:number}[];
  queryFilters?:{id:string;label:string}[];
  querySorts?:{id:string;label:string;primary?:boolean}[];
  diagnostics?:boolean;
  services?:{id:string;version:string}[];
};
export type BeforeCommitInput = { task:Task; draft:Task; action:string; input:Record<string,string>; decision:Extract<WorkflowDecision,{kind:"commit"}> };
export type BeforeCommitResult = {kind:"ok";fields?:Record<string,string>;state?:string;annotations?:string[]}|{kind:"reject";message:string};
export type TaskEvent = { kind:TaskEventKind; task:Task; changedPaths:string[]; revision:number; source:string };
export type HookAnnotations = { annotations?:string[] };
export type Plugin = {
  describe():WorkflowDefinition;
  decide(data:{task:Task; action:string; input:Record<string,string>}):WorkflowDecision;
  contribute?():ExtensionContribution;
  lifecycleActivate?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleReady?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleQuiesce?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleDispose?(data?:Record<string,never>):void|HookAnnotations;
  beforeCommit?(data:BeforeCommitInput):BeforeCommitResult;
  onTaskEvent?(data:TaskEvent):void|HookAnnotations;
};
