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

export const candidateScope = [
  "business/entry.ts",
  "business/view.ts",
  "business/config.json",
  "business/compatibility.json",
];
export function candidateSource(code: string) {
  return JSON.stringify({
    files: [
      { path: "business/entry.ts", content: code },
      {
        path: "business/view.ts",
        content: 'export default {title:"复盘",fields:["reflection"]};',
      },
      { path: "business/config.json", content: "{}" },
      {
        path: "business/compatibility.json",
        content: '{"preserveUnknownFields":true}',
      },
    ],
  });
}
