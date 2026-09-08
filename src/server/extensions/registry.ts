import { AppError } from "../../shared/contracts.js";
import {
  emptyContribution,
  EXTENSIONS_CONTRACT,
  type CommandRegistration,
  type ExtensionCapability,
  type ExtensionContribution,
  type ExtensionSummary,
  type Field,
  type ScheduleRegistration,
  type TaskEventKind,
} from "../business/contracts.js";

export class ExtensionRegistry {
  private pluginId: string | null = null;
  private contribution: ExtensionContribution = emptyContribution();

  clear() {
    this.pluginId = null;
    this.contribution = emptyContribution();
  }

  install(pluginId: string, contribution: ExtensionContribution) {
    this.validate(contribution);
    this.pluginId = pluginId;
    this.contribution = contribution;
  }

  activePluginId() {
    return this.pluginId;
  }

  current() {
    return this.contribution;
  }

  hasBeforeCommit() {
    return !!this.contribution.beforeCommit;
  }

  subscribedEvents(): ReadonlySet<TaskEventKind> {
    return new Set(this.contribution.events ?? []);
  }

  commands(): CommandRegistration[] {
    return this.contribution.commands ?? [];
  }

  fields(): Field[] {
    return this.contribution.fields ?? [];
  }

  schedules(): ScheduleRegistration[] {
    return this.contribution.schedules ?? [];
  }

  hasDiagnostics() {
    return !!this.contribution.diagnostics;
  }

  summarize(): ExtensionSummary {
    if (!this.pluginId)
      return { contractVersion: null, capabilities: [] };
    const providerId = this.pluginId;
    const c = this.contribution;
    const commands = c.commands?.length ?? 0;
    const fields = c.fields?.length ?? 0;
    const events = c.events?.length ?? 0;
    const schedules = c.schedules?.length ?? 0;
    const lifePhases = c.lifecycle
      ? Object.values(c.lifecycle).filter(Boolean).length
      : 0;
    const uiSlots = c.uiSlots?.length ?? 0;
    const filters = c.queryFilters?.length ?? 0;
    const sorts = c.querySorts?.length ?? 0;
    const services = c.services?.length ?? 0;
    const capabilities: ExtensionCapability[] = [
      {
        interfaceId: "workflow.provide",
        status: "active",
        providerId,
        count: 1,
      },
      {
        interfaceId: "command.register",
        status: commands ? "active" : "declared",
        providerId,
        count: commands,
      },
      {
        interfaceId: "fields.register",
        status: fields ? "active" : "declared",
        providerId,
        count: fields,
      },
      {
        interfaceId: "task.beforeCommit",
        status: c.beforeCommit ? "active" : "declared",
        providerId,
        count: c.beforeCommit ? 1 : 0,
      },
      {
        interfaceId: "task.events",
        status: events ? "active" : "declared",
        providerId,
        count: events,
      },
      {
        interfaceId: "schedule.register",
        status: schedules ? "active" : "declared",
        providerId,
        count: schedules,
      },
      {
        interfaceId: "lifecycle",
        status: lifePhases ? "active" : "declared",
        providerId,
        count: lifePhases,
      },
      {
        interfaceId: "ui.slot",
        status: uiSlots ? "stub" : "declared",
        providerId,
        count: uiSlots,
      },
      {
        interfaceId: "query.filter",
        status: filters ? "stub" : "declared",
        providerId,
        count: filters,
      },
      {
        interfaceId: "query.sort",
        status: sorts ? "stub" : "declared",
        providerId,
        count: sorts,
      },
      {
        interfaceId: "diagnostics.annotate",
        status: c.diagnostics ? "stub" : "declared",
        providerId,
        count: c.diagnostics ? 1 : 0,
      },
      {
        interfaceId: "service.provide",
        status: services ? "stub" : "declared",
        providerId,
        count: services,
      },
    ];
    const hasExtensions =
      commands > 0 ||
      fields > 0 ||
      !!c.beforeCommit ||
      events > 0 ||
      schedules > 0 ||
      lifePhases > 0 ||
      uiSlots > 0 ||
      filters > 0 ||
      sorts > 0 ||
      !!c.diagnostics ||
      services > 0;
    return {
      contractVersion: hasExtensions ? EXTENSIONS_CONTRACT : null,
      capabilities,
    };
  }

  private validate(contribution: ExtensionContribution) {
    const fieldKeys = new Set<string>();
    for (const field of contribution.fields ?? []) {
      if (fieldKeys.has(field.key))
        throw new AppError(
          "EXTENSION_CONFLICT",
          `字段重复注册：${field.key}`,
        );
      fieldKeys.add(field.key);
    }
    const commandIds = new Set<string>();
    for (const command of contribution.commands ?? []) {
      if (commandIds.has(command.id))
        throw new AppError(
          "EXTENSION_CONFLICT",
          `命令重复注册：${command.id}`,
        );
      commandIds.add(command.id);
    }
    const scheduleKeys = new Set<string>();
    for (const schedule of contribution.schedules ?? []) {
      if (scheduleKeys.has(schedule.dedupeKey))
        throw new AppError(
          "EXTENSION_CONFLICT",
          `调度幂等键重复：${schedule.dedupeKey}`,
        );
      scheduleKeys.add(schedule.dedupeKey);
      if (schedule.missPolicy !== "skip" && schedule.missPolicy !== "run-once")
        throw new AppError("INVALID_EXTENSION", "无效的错过执行策略");
    }
    let primary = 0;
    for (const sort of contribution.querySorts ?? [])
      if (sort.primary) primary++;
    if (primary > 1)
      throw new AppError("EXTENSION_CONFLICT", "主排序提供者只能有一个");
  }
}
