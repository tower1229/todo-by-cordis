import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "./workspace.js";
import { createControllableClock } from "./host/clock.js";
import { BusinessAssertionError } from "./business-verification.js";
import { importCompositionVersions } from "./workspace-acceptance.js";
import type { Version } from "../release/types.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import { hash } from "../release/storage.js";
import { scheduleCheckId } from "../shared/checker-semantics.js";
import { schedulePolicyChecks, schedulePolicySemantics, type SchedulePolicy, type SchedulePolicyCheck, type SchedulePolicyEvidence } from "../shared/schedule-policy.js";
import type { Task } from "./business/contracts.js";

/** Host-owned timing oracle. Action cases alone cannot prove timer dispatch. */
export async function verifyScheduleViaIsolatedWorkspace(
  formal: Workspace,
  candidate: Version,
  cases: MemberAcceptanceCase[],
  signal: AbortSignal,
  policies: SchedulePolicy[] = [],
  recordPolicy?: (evidence: SchedulePolicyEvidence) => void,
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "cordis-schedule-accept-"));
  const clock = createControllableClock(Date.parse("2030-01-01T00:00:00.000Z"));
  const isolated = await Workspace.open(join(directory, "workspace.db"), {
    acceptanceProbe: true,
    clock,
  });
  const checks: string[] = [];
  const matchedPolicies=new Set<string>();
  try {
    signal.throwIfAborted();
    importCompositionVersions(formal, isolated, candidate);
    await isolated.activateForAcceptance(candidate.id, signal);
    const schedules = isolated.extensionRegistry().schedules();
    if (!schedules.length)
      throw new BusinessAssertionError("定时验收失败：候选未注册调度");
    for (const schedule of schedules) {
      signal.throwIfAborted();
      if (schedule.atKind !== "field" || schedule.onFire.type !== "action")
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 缺少可检验的任务字段触发声明`,
        );
      const fireCommand = isolated
        .extensionRegistry()
        .commands()
        .find(
          (command) =>
            command.id === schedule.onFire.commandId &&
            command.providerId === schedule.providerId,
        );
      if (
        !fireCommand ||
        !fireCommand.internalOnly ||
        !fireCommand.from?.includes("open")
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 到期动作须为仅调度可触发且授权未完成状态的命令`,
        );
      const setter = cases.find(
        (c) =>
          c.expected.kind === "commit" &&
          c.member === schedule.providerId &&
          Object.hasOwn(c.input, schedule.at) &&
          Object.hasOwn(c.expected.fields, schedule.at),
      );
      const fired = cases.find(
        (c) =>
          c.action === schedule.onFire.commandId &&
          c.member === schedule.providerId &&
          c.expected.kind === "commit",
      );
      if (!setter || !fired || fired.expected.kind !== "commit")
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 缺少设置截止与到期动作的冻结正例，普通动作案例不能代替时间验证`,
        );
      const requestedPolicies=policies.filter(p=>p.action.member===schedule.providerId&&p.action.action===schedule.onFire.commandId);
      const firedState=fired.expected.state;
      for (const policy of requestedPolicies) {
        if (policy.version!==1 || !policy.checks.length || new Set(policy.checks).size!==policy.checks.length ||
            policy.checks.some(c=>!Object.hasOwn(schedulePolicySemantics,c)) ||
            policy.fireCase.caseId!==`member:${fired.member}:${fired.name}` || policy.fireCase.definitionHash!==hash(fired))
          throw new BusinessAssertionError(`定时验收失败：${policy.id} 与冻结的到期案例不一致`);
        matchedPolicies.add(policy.id);
      }
      const expectedField = Object.entries(fired.expected.fields).find(
        ([key, value]) => key !== schedule.at && fired.fields[key] !== value,
      );
      if (!expectedField && fired.expected.state === fired.state)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 到期正例没有可观察的状态或字段变化`,
        );
      const revision = () => isolated.composition().revision;
      const effects=Object.fromEntries(Object.entries(fired.expected.fields).filter(([key,value])=>key!==schedule.at&&fired.fields[key]!==value));
      if (requestedPolicies.length && !Object.keys(effects).length)
        throw new BusinessAssertionError(`定时策略 ${schedule.id} 缺少冻结的字段型到期效果`);
      const hasEffects=(task:Task)=>Object.entries(effects).every(([key,value])=>task.fields[key]===value);
      const policyEvidence=new Map<SchedulePolicyCheck,SchedulePolicyEvidence>();
      const policyCheck=async(policy:SchedulePolicy,check:SchedulePolicyCheck,state:string,run:(step:(operation:string,task:Task)=>void)=>Promise<void>)=>{
        const caseId=schedulePolicyChecks(policy).find(ref=>ref.caseId.endsWith(`:${check}`))!.caseId;
        const cached=policyEvidence.get(check);
        if (cached) {
          recordPolicy?.({...structuredClone(cached),caseId,policyId:policy.id,policyHash:hash(policy),sourceCase:structuredClone(policy.fireCase)});
          checks.push(caseId);
          return;
        }
        const receipt:SchedulePolicyEvidence={checker:"schedule/1",caseId,policyId:policy.id,policyHash:hash(policy),candidateVersionId:candidate.id,member:schedule.providerId,memberVersionId:isolated.composition().members.find(m=>m.pluginId===schedule.providerId)!.versionId,sourceCase:structuredClone(policy.fireCase),expected:{state,fields:{...effects}},steps:[],status:"failed",diagnostic:"时序策略尚未完成"};
        try {
          signal.throwIfAborted();
          await run((operation,task)=>receipt.steps.push({operation,at:new Date(clock.now()).toISOString(),state:task.state,fields:{...task.fields},revision:task.revision}));
          signal.throwIfAborted();
          receipt.status="passed"; receipt.diagnostic="真实调度和工作流操作链通过冻结业务策略";
          policyEvidence.set(check,structuredClone(receipt));
          checks.push(caseId);
        } catch(error) {
          receipt.diagnostic=error instanceof Error?error.message:String(error);
          throw error;
        } finally { recordPolicy?.(structuredClone(receipt)); }
      };
      const create = async () => {
        const created = await isolated.command({
          type: "create",
          title: `schedule-case:${randomUUID()}`,
          operationId: randomUUID(),
          compositionRevision: revision(),
        });
        if (!created.task) throw new Error("无法创建调度验收任务");
        return created.task;
      };
      for (const policy of requestedPolicies.filter((p) => p.checks.includes("set-past-due")))
        await policyCheck(policy, "set-past-due", firedState, async (step) => {
          const task = await create();
          step("create-open", task);
          const pastAt = new Date(clock.now() - 60_000).toISOString();
          await isolated.command({
            type: "action",
            taskId: task.id,
            actionId: setter.action,
            input: { ...setter.input, [schedule.at]: pastAt },
            expectedRevision: task.revision,
            operationId: randomUUID(),
            compositionRevision: revision(),
          });
          const dated = isolated.read(task.id);
          step("set-past-deadline", dated);
          if (dated.state !== "open" || dated.fields[schedule.at] !== pastAt)
            throw new BusinessAssertionError(`定时策略 ${policy.id} 未完成任务未接受过去截止时间`);
          await clock.advance(0);
          await isolated.whenSchedulesIdle();
          const expired = isolated.read(task.id);
          step("scheduled-catch-up", expired);
          if (expired.state !== firedState || !hasEffects(expired))
            throw new BusinessAssertionError(`定时策略 ${policy.id} 设置过去截止后未由真实调度补执行`);
        });
      const at = new Date(clock.now() + 60_000).toISOString();
      const task = await create();
      if (isolated.schedulerState().armed !== 0)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 未设置截止却已调度`,
        );
      await isolated.command({
        type: "action",
        taskId: task.id,
        actionId: setter.action,
        input: { ...setter.input, [schedule.at]: at },
        expectedRevision: task.revision,
        operationId: randomUUID(),
        compositionRevision: revision(),
      });
      const before = isolated.read(task.id);
      if (before.fields[schedule.at] !== at || !isolated.schedulerState().armed)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 有效截止未武装`,
        );
      if (
        before.state === fired.expected.state &&
        (!expectedField || before.fields[expectedField[0]] === expectedField[1])
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 到期效果在触发前已出现`,
        );
      await clock.advance(59_999);
      const early = isolated.read(task.id);
      if (
        early.revision !== before.revision ||
        hash(early.fields) !== hash(before.fields)
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 提前触发`,
        );
      await clock.advance(1);
      const after = isolated.read(task.id);
      if (
        after.revision <= before.revision ||
        after.state !== fired.expected.state ||
        (expectedField && after.fields[expectedField[0]] !== expectedField[1])
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 到点未通过真实调度提交预期事实`,
        );
      checks.push(scheduleCheckId(schedule.id, "on-time"));
      for (const policy of requestedPolicies.filter(p=>p.checks.includes("complete-retains-effect")))
        await policyCheck(policy,"complete-retains-effect","done",async step=>{
          const expired=isolated.read(task.id); step("scheduled-effect",expired);
          await isolated.command({type:"action",taskId:expired.id,actionId:"complete",input:{},expectedRevision:expired.revision,operationId:randomUUID(),compositionRevision:revision()});
          const completed=isolated.read(task.id); step("complete",completed);
          if (completed.state!=="done" || !hasEffects(completed))
            throw new BusinessAssertionError(`定时策略 ${policy.id} 完成后未保留到期效果；实际 ${JSON.stringify({state:completed.state,fields:completed.fields})}`);
        });

      const doneTask = await create();
      await isolated.command({
        type: "action",
        taskId: doneTask.id,
        actionId: setter.action,
        input: {
          ...setter.input,
          [schedule.at]: new Date(clock.now() + 60_000).toISOString(),
        },
        expectedRevision: doneTask.revision,
        operationId: randomUUID(),
        compositionRevision: revision(),
      });
      const dated = isolated.read(doneTask.id);
      const complete = isolated
        .composition()
        .workflow.actions.find(
          (a) => a.id === "complete" && a.from.includes(dated.state),
        );
      if (!complete)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 无法验证提前完成`,
        );
      await isolated.command({
        type: "action",
        taskId: doneTask.id,
        actionId: complete.id,
        input: {},
        expectedRevision: dated.revision,
        operationId: randomUUID(),
        compositionRevision: revision(),
      });
      const completed = isolated.read(doneTask.id);
      await clock.advance(60_000);
      const retained = isolated.read(doneTask.id);
      if (
        retained.revision !== completed.revision ||
        hash(retained.fields) !== hash(completed.fields)
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 误标已完成任务`,
        );
      checks.push(scheduleCheckId(schedule.id, "completed-safe"));
      for (const policy of requestedPolicies.filter(p=>p.checks.includes("reopen-after-due")))
        await policyCheck(policy,"reopen-after-due",firedState,async step=>{
          step("complete-before-due",completed); step("past-due-while-completed",retained);
          await isolated.command({type:"action",taskId:retained.id,actionId:"reopen",input:{},expectedRevision:retained.revision,operationId:randomUUID(),compositionRevision:revision()});
          step("reopen",isolated.read(retained.id));
          await clock.advance(0); await isolated.whenSchedulesIdle();
          const reopened=isolated.read(retained.id); step("scheduled-catch-up",reopened);
          if (reopened.state!==firedState || !hasEffects(reopened))
            throw new BusinessAssertionError(`定时策略 ${policy.id} 截止后重开未由真实调度补执行；实际 ${JSON.stringify({state:reopened.state,fields:reopened.fields})}`);
        });

      const changeTask = await create();
      const oldAt = new Date(clock.now() + 60_000).toISOString();
      const newAt = new Date(clock.now() + 120_000).toISOString();
      const setDue = async (id: string, taskRevision: number, value: string) =>
        isolated.command({
          type: "action",
          taskId: id,
          actionId: setter.action,
          input: { ...setter.input, [schedule.at]: value },
          expectedRevision: taskRevision,
          operationId: randomUUID(),
          compositionRevision: revision(),
        });
      const oldDated = await setDue(changeTask.id, changeTask.revision, oldAt);
      if (!oldDated.task) throw new Error("无法设置原截止时间");
      const newDated = await setDue(
        changeTask.id,
        oldDated.task.revision,
        newAt,
      );
      if (newDated.task?.fields[schedule.at] !== newAt)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 修改截止失败`,
        );
      await clock.advance(60_000);
      const atOldTime = isolated.read(changeTask.id);
      if (atOldTime.revision !== newDated.task.revision)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 旧截止仍触发`,
        );
      await clock.advance(60_000);
      const atNewTime = isolated.read(changeTask.id);
      if (
        atNewTime.revision !== atOldTime.revision + 1 ||
        atNewTime.state !== fired.expected.state ||
        (expectedField &&
          atNewTime.fields[expectedField[0]] !== expectedField[1])
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 新截止未触发`,
        );
      await clock.advance(1);
      if (isolated.read(changeTask.id).revision !== atNewTime.revision)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 重复触发`,
        );
      checks.push(scheduleCheckId(schedule.id, "updated-once"));

      const clearedTask = await create();
      const clearAt = new Date(clock.now() + 60_000).toISOString();
      const setForClear = await setDue(
        clearedTask.id,
        clearedTask.revision,
        clearAt,
      );
      if (!setForClear.task) throw new Error("无法设置待清除截止时间");
      const cleared = await setDue(
        clearedTask.id,
        setForClear.task.revision,
        "",
      );
      if (
        !cleared.task ||
        cleared.task.fields[schedule.at] ||
        isolated.schedulerState().armed !== 0
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 清除未撤销调度`,
        );
      await clock.advance(60_000);
      if (isolated.read(clearedTask.id).revision !== cleared.task.revision)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 清除后仍触发`,
        );
      checks.push(scheduleCheckId(schedule.id, "cleared"));

      const deleteTask = await create();
      const deleteAt = new Date(clock.now() + 60_000).toISOString();
      const setForDelete = await setDue(
        deleteTask.id,
        deleteTask.revision,
        deleteAt,
      );
      if (!setForDelete.task) throw new Error("无法设置待删除截止时间");
      const deleted = await isolated.command({
        type: "delete",
        taskId: deleteTask.id,
        expectedRevision: setForDelete.task.revision,
        operationId: randomUUID(),
        compositionRevision: revision(),
      });
      if (isolated.schedulerState().armed !== 0)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 删除未撤销调度`,
        );
      await clock.advance(60_000);
      const retainedDelete = isolated.read(deleteTask.id);
      if (
        !retainedDelete.deletedAt ||
        retainedDelete.revision !== deleted.task?.revision
      )
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 删除后仍触发或恢复`,
        );
      checks.push(scheduleCheckId(schedule.id, "deleted"));

      const missedTask = await create();
      const missedAt = new Date(clock.now() + 60_000).toISOString();
      const missedDated = await setDue(
        missedTask.id,
        missedTask.revision,
        missedAt,
      );
      if (!missedDated.task) throw new Error("无法设置恢复检查截止时间");
      isolated.testHarness()?.scheduleService.stop();
      await clock.advance(60_000);
      await isolated.restart();
      await isolated.whenSchedulesIdle();
      const afterRecovery = isolated.read(missedTask.id);
      if (schedule.missPolicy === "run-once") {
        if (
          afterRecovery.revision !== missedDated.task.revision + 1 ||
          afterRecovery.state !== fired.expected.state ||
          (expectedField &&
            afterRecovery.fields[expectedField[0]] !== expectedField[1])
        )
          throw new BusinessAssertionError(
            `定时验收失败：${schedule.id} 恢复后未补执行有效截止`,
          );
        await isolated.restart();
        await isolated.whenSchedulesIdle();
        if (isolated.read(missedTask.id).revision !== afterRecovery.revision)
          throw new BusinessAssertionError(
            `定时验收失败：${schedule.id} 重复恢复触发`,
          );
      } else if (afterRecovery.revision !== missedDated.task.revision) {
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} skip 策略误补执行`,
        );
      }
      checks.push(scheduleCheckId(schedule.id, `recovery-${schedule.missPolicy}`));
      for (const policy of requestedPolicies.filter(p => p.checks.includes("reset-clears-effect")))
        await policyCheck(policy, "reset-clears-effect", "open", async step => {
          for (const operation of ["modify", "clear"] as const) {
            const task = await create();
            await setDue(task.id, task.revision,
              new Date(clock.now() + 60_000).toISOString());
            await clock.advance(60_000);
            await isolated.whenSchedulesIdle();
            const expired = isolated.read(task.id);
            step(`${operation}:scheduled-effect`, expired);
            if (expired.state !== "open" || !hasEffects(expired))
              throw new BusinessAssertionError(`定时策略 ${policy.id} 缺少真实到期后的未完成任务`);
            const nextAt = new Date(clock.now() + 60_000).toISOString();
            const input = operation === "clear" ? "" : nextAt;
            await setDue(expired.id, expired.revision, input);
            const reset = isolated.read(task.id);
            step(`${operation}:reset`, reset);
            if (
              reset.state !== "open" ||
              (operation === "clear" ? !!reset.fields[schedule.at] : reset.fields[schedule.at] !== nextAt) ||
              Object.entries(effects).some(([key, value]) => reset.fields[key] === value)
            )
              throw new BusinessAssertionError(`定时策略 ${policy.id} 修改或清除截止未清除旧到期效果：${operation}`);
            await clock.advance(60_000);
            await isolated.whenSchedulesIdle();
            const settled = isolated.read(task.id);
            step(`${operation}:after-deadline`, settled);
            if (operation === "clear") {
              if (settled.revision !== reset.revision || hash(settled.fields) !== hash(reset.fields))
                throw new BusinessAssertionError(`定时策略 ${policy.id} 清除截止后仍触发`);
            } else if (settled.state !== firedState || !hasEffects(settled) || settled.revision !== reset.revision + 1) {
              throw new BusinessAssertionError(`定时策略 ${policy.id} 修改截止后未按新时间执行`);
            }
          }
        });
    }
    if (policies.some(policy=>!matchedPolicies.has(policy.id)))
      throw new BusinessAssertionError("定时策略没有绑定候选实际登记的调度，不能跳过冻结义务");
    return checks;
  } finally {
    await isolated.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
