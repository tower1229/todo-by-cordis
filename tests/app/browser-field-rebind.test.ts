import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {inheritBrowserCases} from "../../src/evolution/references.js";

const replay = () => JSON.parse(readFileSync(new URL("../fixtures/browser-field-rebind-replay.json",import.meta.url),"utf8")) as {
  previous: Parameters<typeof inheritBrowserCases>[1];
  next: Parameters<typeof inheritBrowserCases>[0];
  reason: string;
};

test("原生归档反例：字段义务身份和历史准备更新时，旧动作后大写断言进入显式替代而非重新继承", () => {
  const f=replay();const before=structuredClone(f);
  const result=inheritBrowserCases(f.next,f.previous,f.reason);
  assert.deepEqual(result.blockers,[]);
  assert.deepEqual(result.browserCases,f.next.browserCases,"当前小写断言保留；旧的同操作大写断言不能重新继承");
  assert.equal(result.changes.length,f.previous.browserCases!.length);
  for(const [i,change] of result.changes.entries()){
    assert.deepEqual(JSON.parse(change.before),f.previous.browserCases![i]);
    assert.deepEqual(JSON.parse(change.after),f.next.browserCases![0]);
    assert.equal(change.reason,f.reason);
  }
  assert.ok(f.next.browserCases![0].prepare,"新断言仍先用旧版本真实准备大写历史值");
  assert.deepEqual(f,before,"历史定义不被改写");
});

for (const [name,change] of [
  ["不同新旧任务",(f:ReturnType<typeof replay>)=>{f.next.browserCases![0].task="new";}],
  ["不同动作输入",(f:ReturnType<typeof replay>)=>{const s=f.next.browserCases![0].steps.find(s=>s.kind==="action")!;if(s.kind==="action")s.input={tags:"different"};}],
  ["缺少刷新检查",(f:ReturnType<typeof replay>)=>{f.next.browserCases![0].steps=f.next.browserCases![0].steps.filter(s=>s.kind!=="refresh");}],
  ["缺少重启检查",(f:ReturnType<typeof replay>)=>{f.next.browserCases![0].steps=f.next.browserCases![0].steps.filter(s=>s.kind!=="restart");}],
  ["不同动作所有者",(f:ReturnType<typeof replay>)=>{for(const s of f.next.browserCases![0].steps)if(s.kind==="action")s.member="other";}],
  ["不同字段所有者",(f:ReturnType<typeof replay>)=>{for(const r of f.next.requirements!)for(const o of r.obligations??[])if(o.kind==="field")o.member="other";}],
  ["未保留原要求身份",(f:ReturnType<typeof replay>)=>{f.next.requirements=f.next.requirements!.map(r=>({...r,id:r.id+"-new"}));}],
  ["旧案例是系统保护",(f:ReturnType<typeof replay>)=>{for(const c of f.previous.browserCases!)c.classification="system-protection";}],
  ["新案例是系统保护",(f:ReturnType<typeof replay>)=>{f.next.browserCases![0].classification="system-protection";}],
  ["未知旧义务",(f:ReturnType<typeof replay>)=>{for(const c of f.previous.browserCases!)c.obligationId="unknown";}],
  ["替代案例不唯一",(f:ReturnType<typeof replay>)=>{f.next.browserCases!.push({...structuredClone(f.next.browserCases![0]),id:"ambiguous-current-case"});}],
  ["已有历史准备被移除",(f:ReturnType<typeof replay>)=>{for(const c of f.previous.browserCases!)c.prepare=structuredClone(f.next.browserCases![0].prepare);delete f.next.browserCases![0].prepare;}],
] as const) test(`浏览器继承拒绝隐式替代：${name}`,()=>{
  const f=replay();change(f);const result=inheritBrowserCases(f.next,f.previous,f.reason);
  for(const old of f.previous.browserCases!)assert.ok(result.browserCases.some(c=>c.id===old.id),"不能丢弃未证明可替代的旧断言");
  assert.equal(result.changes.length,0);
});

test("浏览器替代必须说明验收修订原因，旧案例保留且不能进入无阻塞计划",()=>{
  const f=replay();const result=inheritBrowserCases(f.next,f.previous,"");
  assert.equal(result.blockers.length,f.previous.browserCases!.length);assert.equal(result.changes.length,0);
  for(const old of f.previous.browserCases!)assert.ok(result.browserCases.some(c=>c.id===old.id));
});

test("无动作的初始字段值不能靠忽略字面值或增加历史准备替代",()=>{
  for(const prepare of [false,true]){
    const f=replay();
    for(const c of [...f.previous.browserCases!,...f.next.browserCases!])c.steps=c.steps.filter(s=>s.kind!=="action");
    if(!prepare)delete f.next.browserCases![0].prepare;
    else for(const step of f.next.browserCases![0].steps)if(step.kind==="field")step.value="Alpha Project";
    const result=inheritBrowserCases(f.next,f.previous,f.reason);
    for(const old of f.previous.browserCases!)assert.ok(result.browserCases.some(c=>c.id===old.id));
    assert.equal(result.changes.length,0);
  }
});

test("旧字段未限定贡献时，跨要求出现多个当前贡献仍须保留旧断言",()=>{
  const f=replay();const old=f.previous.browserCases!.find(c=>c.steps.some(s=>s.kind==="field"&&!s.contribution))!;
  const owner=f.previous.requirements!.find(r=>r.obligations?.some(o=>o.id===old.obligationId))!;
  const current=f.next.requirements!.find(r=>r.id===owner.id)!;
  const extra=structuredClone(current);extra.id="different-current-scope";
  for(const o of extra.obligations??[])if(o.kind==="field")o.contribution="other-slot";
  f.next.requirements!.push(extra);
  const result=inheritBrowserCases(f.next,f.previous,f.reason);
  assert.ok(result.browserCases.some(c=>c.id===old.id));
});
