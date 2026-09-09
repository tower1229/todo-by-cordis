import { AppError } from "../../shared/contracts.js";
import {
  emptyContribution,
  EXTENSIONS_CONTRACT,
  type Action,
  type CommandRegistration,
  type ExtensionCapability,
  type ExtensionContribution,
  type ExtensionSummary,
  type Field,
  type ScheduleRegistration,
  type TaskEventKind,
  type WorkflowDefinition,
} from "../business/contracts.js";
import type { VersionMemberRole } from "../../release/types.js";

type InstalledPlugin = {
  pluginId: string;
  role: VersionMemberRole;
  contribution: ExtensionContribution;
};

export class ExtensionRegistry {
  private plugins: InstalledPlugin[] = [];

  clear() {
    this.plugins = [];
  }

  install(
    pluginId: string,
    contribution: ExtensionContribution,
    workflowFields: Field[] = [],
    role: VersionMemberRole = "workflow",
    workflowActions: Action[] = [],
  ) {
    this.installAll([
      { pluginId, contribution, role, workflowFields, workflowActions },
    ]);
  }

  installAll(
    installs: Array<{
      pluginId: string;
      contribution: ExtensionContribution;
      role: VersionMemberRole;
      workflowFields?: Field[];
      workflowActions?: Action[];
    }>,
  ) {
    const workflow = installs.find((i) => i.role === "workflow");
    this.validateAll(
      installs,
      workflow?.workflowFields ?? [],
      workflow?.workflowActions ?? [],
    );
    this.plugins = installs.map((i) => ({
      pluginId: i.pluginId,
      role: i.role,
      contribution: i.contribution,
    }));
  }

  activePluginId() {
    return (
      this.plugins.find((p) => p.role === "workflow")?.pluginId ??
      this.plugins[0]?.pluginId ??
      null
    );
  }

  current() {
    return (
      this.plugins.find((p) => p.role === "workflow")?.contribution ??
      emptyContribution()
    );
  }

  providers() {
    return this.plugins.map((p) => ({
      pluginId: p.pluginId,
      role: p.role,
      contribution: p.contribution,
    }));
  }

  commandProvider(commandId: string): string | null {
    for (const plugin of this.plugins) {
      if ((plugin.contribution.commands ?? []).some((c) => c.id === commandId))
        return plugin.pluginId;
    }
    return null;
  }

  hasBeforeCommit() {
    return this.plugins.some((p) => p.contribution.beforeCommit);
  }

  beforeCommitProviders(): string[] {
    return this.plugins
      .filter((p) => p.contribution.beforeCommit)
      .map((p) => p.pluginId);
  }

  subscribedEvents(): ReadonlySet<TaskEventKind> {
    const kinds = new Set<TaskEventKind>();
    for (const plugin of this.plugins)
      for (const kind of plugin.contribution.events ?? []) kinds.add(kind);
    return kinds;
  }

  eventProviders(kind: TaskEventKind): string[] {
    return this.plugins
      .filter((p) => (p.contribution.events ?? []).includes(kind))
      .map((p) => p.pluginId);
  }

  commands(): Array<CommandRegistration & { providerId: string }> {
    return this.plugins.flatMap((p) =>
      (p.contribution.commands ?? []).map((c) => ({
        ...c,
        providerId: p.pluginId,
      })),
    );
  }

  fields(): Array<Field & { providerId: string }> {
    return this.plugins.flatMap((p) =>
      (p.contribution.fields ?? []).map((f) => ({
        ...f,
        providerId: p.pluginId,
      })),
    );
  }

  schedules(): ScheduleRegistration[] {
    return this.plugins.flatMap((p) => p.contribution.schedules ?? []);
  }

  hasFieldSchedules() {
    return this.schedules().some((s) => (s.atKind ?? "absolute") === "field");
  }

  hasDiagnostics() {
    return this.plugins.some((p) => p.contribution.diagnostics);
  }

  lifecycleProviders(
    phase: keyof NonNullable<ExtensionContribution["lifecycle"]>,
  ): string[] {
    return this.plugins
      .filter((p) => p.contribution.lifecycle?.[phase])
      .map((p) => p.pluginId);
  }

  mergedFields(workflow: WorkflowDefinition): Field[] {
    const workflowProvider = this.activePluginId() ?? workflow.id;
    const keys = new Set<string>();
    const result: Field[] = [];
    for (const field of workflow.fields) {
      keys.add(field.key);
      result.push({
        ...field,
        providerId: field.providerId ?? workflowProvider,
      });
    }
    for (const field of this.fields()) {
      if (keys.has(field.key)) continue;
      keys.add(field.key);
      result.push(field);
    }
    return result;
  }

  mergedActions(workflow: WorkflowDefinition): Action[] {
    const workflowProvider = this.activePluginId() ?? workflow.id;
    const ids = new Set<string>();
    const result: Action[] = [];
    for (const action of workflow.actions) {
      ids.add(action.id);
      result.push({
        ...action,
        providerId: action.providerId ?? workflowProvider,
      });
    }
    for (const command of this.commands()) {
      if (ids.has(command.id)) continue;
      ids.add(command.id);
      result.push({
        id: command.id,
        label: command.label,
        from: command.from?.length ? command.from : ["open"],
        providerId: command.providerId,
      });
    }
    return result;
  }

  summarize(): ExtensionSummary {
    if (!this.plugins.length)
      return { contractVersion: null, capabilities: [] };
    const capabilities: ExtensionCapability[] = [];
    let hasExtensions = false;
    for (const plugin of this.plugins) {
      const providerId = plugin.pluginId;
      const c = plugin.contribution;
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
      if (plugin.role === "workflow")
        capabilities.push({
          interfaceId: "workflow.provide",
          status: "active",
          providerId,
          count: 1,
        });
      capabilities.push(
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
          status: c.diagnostics ? "active" : "declared",
          providerId,
          count: c.diagnostics ? 1 : 0,
        },
        {
          interfaceId: "service.provide",
          status: services ? "stub" : "declared",
          providerId,
          count: services,
        },
      );
      if (
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
        services > 0
      )
        hasExtensions = true;
    }
    return {
      contractVersion: hasExtensions ? EXTENSIONS_CONTRACT : null,
      capabilities,
    };
  }

  private validateAll(
    installs: Array<{
      pluginId: string;
      contribution: ExtensionContribution;
      role: VersionMemberRole;
    }>,
    workflowFields: Field[],
    workflowActions: Action[],
  ) {
    const pluginIds = new Set<string>();
    const workflowKeys = new Set(workflowFields.map((f) => f.key));
    const workflowActionIds = new Set(workflowActions.map((a) => a.id));
    const fieldKeys = new Set<string>();
    const commandIds = new Set<string>();
    const scheduleKeys = new Set<string>();
    let primary = 0;
    let workflows = 0;
    for (const install of installs) {
      if (pluginIds.has(install.pluginId))
        throw new AppError(
          "EXTENSION_CONFLICT",
          `组合内插件身份重复：${install.pluginId}`,
        );
      pluginIds.add(install.pluginId);
      if (install.role === "workflow") workflows++;
      for (const field of install.contribution.fields ?? []) {
        if (fieldKeys.has(field.key))
          throw new AppError(
            "EXTENSION_CONFLICT",
            `字段重复注册：${field.key}`,
          );
        if (workflowKeys.has(field.key))
          throw new AppError(
            "EXTENSION_CONFLICT",
            `字段与流程定义冲突：${field.key}`,
          );
        fieldKeys.add(field.key);
      }
      for (const command of install.contribution.commands ?? []) {
        if (commandIds.has(command.id))
          throw new AppError(
            "EXTENSION_CONFLICT",
            `命令重复注册：${command.id}`,
          );
        if (
          install.role !== "workflow" &&
          workflowActionIds.has(command.id)
        )
          throw new AppError(
            "EXTENSION_CONFLICT",
            `命令与流程定义冲突：${command.id}`,
          );
        commandIds.add(command.id);
      }
      for (const schedule of install.contribution.schedules ?? []) {
        if (scheduleKeys.has(schedule.dedupeKey))
          throw new AppError(
            "EXTENSION_CONFLICT",
            `调度幂等键重复：${schedule.dedupeKey}`,
          );
        scheduleKeys.add(schedule.dedupeKey);
        if (
          schedule.missPolicy !== "skip" &&
          schedule.missPolicy !== "run-once"
        )
          throw new AppError("INVALID_EXTENSION", "无效的错过执行策略");
        const kind = schedule.atKind ?? "absolute";
        if (kind !== "absolute" && kind !== "field")
          throw new AppError("INVALID_EXTENSION", "无效的调度时间类型");
        if (kind === "absolute" && !schedule.onFire.taskId)
          throw new AppError("INVALID_EXTENSION", "绝对调度缺少 taskId");
      }
      for (const sort of install.contribution.querySorts ?? [])
        if (sort.primary) primary++;
    }
    if (workflows !== 1)
      throw new AppError(
        "EXTENSION_CONFLICT",
        "组合内有且仅有一个主工作流提供者",
      );
    if (primary > 1)
      throw new AppError("EXTENSION_CONFLICT", "主排序提供者只能有一个");
  }
}
