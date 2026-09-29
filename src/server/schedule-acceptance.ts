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

/** Host-owned timing oracle. Action cases alone cannot prove timer dispatch. */
export async function verifyScheduleViaIsolatedWorkspace(
  formal: Workspace,
  candidate: Version,
  cases: MemberAcceptanceCase[],
  signal: AbortSignal,
): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "cordis-schedule-accept-"));
  const clock = createControllableClock(Date.parse("2030-01-01T00:00:00.000Z"));
  const isolated = await Workspace.open(join(directory, "workspace.db"), {
    acceptanceProbe: true,
    clock,
  });
  const checks: string[] = [];
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
      const expectedField = Object.entries(fired.expected.fields).find(
        ([key, value]) => key !== schedule.at && fired.fields[key] !== value,
      );
      if (!expectedField && fired.expected.state === fired.state)
        throw new BusinessAssertionError(
          `定时验收失败：${schedule.id} 到期正例没有可观察的状态或字段变化`,
        );
      const revision = () => isolated.composition().revision;
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
      checks.push(`schedule/1:${schedule.id}:on-time`);

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
      checks.push(`schedule/1:${schedule.id}:completed-safe`);

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
      checks.push(`schedule/1:${schedule.id}:updated-once`);

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
      checks.push(`schedule/1:${schedule.id}:cleared`);

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
      checks.push(`schedule/1:${schedule.id}:deleted`);

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
      checks.push(`schedule/1:${schedule.id}:recovery-${schedule.missPolicy}`);
    }
    return checks;
  } finally {
    await isolated.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
