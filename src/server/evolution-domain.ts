import {
  BusinessAssertionError,
  verifyExtensions,
  type BusinessExtensions,
  type MemberAcceptanceCase,
} from "./business-verification.js";
import {
  unauthorizedMemberCommands,
  type AffectedAcceptance,
} from "./affected-acceptance.js";
import {
  assertWorkspaceCaseCoverage,
  requireAffectedAcceptanceForMemberChange,
  verifyViaIsolatedWorkspace,
  type WorkspaceAcceptanceCase,
  type WorkspaceCaseEvidence,
} from "./workspace-acceptance.js";
import {
  capture,
  planningInstruction,
  planningTools,
  readInvestigation,
  parsePlan,
  memberAcceptancePayload,
  type Investigation,
} from "./planning.js";
import type {
  PlanEvidence,
  InvestigatedPlan,
  ExperienceReport,
} from "../shared/assistant.js";
import type { Domain, Target } from "../evolution/evolution.js";
import { Workspace } from "./workspace.js";
import {
  AppError,
  type WorkflowDefinition,
  type WorkflowDecision,
  type Task,
} from "../shared/contracts.js";
import type { RuntimeLike, Version, VersionMember } from "../release/types.js";
import {
  composeCandidateMembers,
  memberEnabledDataImpact,
  resolveVersionMembers,
  validateCompositionMembers,
} from "../release/composition.js";
import {
  parseBusinessFiles,
  ProtectedCandidateError,
  CandidateValidationError,
  synthesizeMemberBundle,
} from "../release/business-bundle.js";
import type { BusinessBundle } from "../release/types.js";
import { hash } from "../release/storage.js";
import type { ExtensionContribution } from "./business/contracts.js";
import { emptyContribution } from "./business/contracts.js";
import { resolveUiContributions } from "./extensions/ui-slots.js";

type Rule = {
  key: string;
  label: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};
type MemberAddition = { pluginId: string; name: string };
type MemberUpgrade = { pluginId: string };
type Goal = {
  memberEnabled?: InvestigatedPlan["memberEnabled"];
  pluginId: string;
  name: string;
  fields: Rule[];
  extensions?: BusinessExtensions;
  memberCases?: MemberAcceptanceCase[];
  affectedAcceptance?: AffectedAcceptance;
  repairEvidence?: InvestigatedPlan["repairEvidence"];
  acceptanceRevision?: InvestigatedPlan["acceptanceRevision"];
  scope?: string[];
  capabilities?: InvestigatedPlan["capabilityChanges"];
  memberAdditions?: MemberAddition[];
  memberUpgrades?: MemberUpgrade[];
};
type SubmittedMember = { pluginId: string; source: string };
type DraftMemberChange =
  | {
      kind: "addition";
      planned: MemberAddition;
      submitted: SubmittedMember;
      draft: Version;
    }
  | {
      kind: "upgrade";
      planned: MemberUpgrade;
      submitted: SubmittedMember;
      draft: Version;
      prior: VersionMember;
      priorVersion: Version;
    };

function acceptanceDefinitionHash(goal: {
  fields: Rule[];
  extensions?: BusinessExtensions;
  memberCases?: MemberAcceptanceCase[];
}) {
  return hash({
    rules: goal.fields,
    extensions: goal.extensions,
    memberCases: goal.memberCases,
  });
}

function fieldContract(
  fields: { key: string; label: string; type: string; required?: boolean }[],
) {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: !!f.required,
  }));
}

function workflowUnchangedForUpgrade(
  base: Version,
  goal: Goal,
  workflowSource: string,
  plannedAdditions: MemberAddition[],
  plannedUpgrades: MemberUpgrade[],
) {
  if (!plannedUpgrades.length || plannedAdditions.length || goal.extensions)
    return false;
  if (workflowSource !== base.source || goal.pluginId !== base.pluginId)
    return false;
  return equal(
    fieldContract(
      goal.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: "text",
        required: f.required,
      })),
    ),
    fieldContract((base.definition as WorkflowDefinition).fields),
  );
}

function splitCandidateSubmission(source: string): {
  workflowSource: string;
  members: SubmittedMember[];
} {
  if (!source.startsWith("{")) return { workflowSource: source, members: [] };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return { workflowSource: source, members: [] };
  }
  const members = parseSubmittedMembers(parsed.members);
  if (Array.isArray(parsed.files))
    return {
      workflowSource: JSON.stringify({ files: parsed.files }),
      members,
    };
  if (typeof parsed.source === "string")
    return { workflowSource: parsed.source, members };
  if (members.length && !("files" in parsed) && !("source" in parsed))
    throw new ProtectedCandidateError("成员候选缺少工作流源码");
  return { workflowSource: source, members: [] };
}

function parseSubmittedMembers(value: unknown): SubmittedMember[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 1)
    throw new ProtectedCandidateError(
      "成员提交无效：本阶段每次变更最多提交一个辅助成员源码",
    );
  const members = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ProtectedCandidateError("成员提交无效");
    const row = item as Record<string, unknown>;
    if (
      typeof row.pluginId !== "string" ||
      typeof row.source !== "string" ||
      !row.pluginId.trim() ||
      !row.source.trim() ||
      Object.keys(row).some((key) => !["pluginId", "source"].includes(key))
    )
      throw new ProtectedCandidateError("成员提交无效");
    return { pluginId: row.pluginId.trim(), source: row.source };
  });
  if (new Set(members.map((m) => m.pluginId)).size !== members.length)
    throw new ProtectedCandidateError("成员提交身份重复");
  return members;
}
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);

/** Shared valid complete-input map for decide and Workspace acceptance cases. */
export function validFieldInputs(fields: Rule[]) {
  return Object.fromEntries(
    fields.map((f) => [
      f.key,
      "文".repeat(Math.max(f.required ? 1 : 0, f.minLength)),
    ]),
  );
}
export const contract = `// Plugin below is the primary workflow contract. Auxiliary members are self-contained modules,
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
  uiSlots?:{id:string;slot:"task.detail";title?:string;body?:string;actions?:{commandId:string;label:string}[];fields?:{key:string;label:string}[];order?:number}[];
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
`;
export class EvolutionDomain implements Domain {
  constructor(private workspace: Workspace) {}
  context() {
    return capture(this.workspace);
  }
  planningInstruction = planningInstruction;
  planningTools = planningTools;
  read(name: string, args: Record<string, unknown>, context: Investigation) {
    return readInvestigation(name, args, context);
  }
  parse(value: unknown, context: Investigation, seen: PlanEvidence[]) {
    const parsed = parsePlan(value, context, seen);
    if (
      this.workspace.composition().revision !== context.revision ||
      this.workspace.activeVersion().id !== context.versionId
    )
      parsed.blockers.push("基础版本已变化，请重新调查");
    const current = capture(this.workspace);
    if (hash(current.files) !== hash(context.files))
      parsed.blockers.push("调查期间实现资料已变化，请重新调查");
    return parsed;
  }
  async reproduce(plan: InvestigatedPlan, signal: AbortSignal) {
    const base = this.workspace.release.get(plan.baseVersion!);
    this.check(this.target(plan), plan.compositionRevision);
    const goal = this.target(plan).payload as Goal;
    const definitionHash = acceptanceDefinitionHash(goal);
    const reproductionCases: WorkspaceCaseEvidence[] = [];
    const reproduced = (diagnostic: string) => ({
      baseVersion: base.id,
      definitionHash,
      diagnostic,
      workspaceCases: reproductionCases,
    });
    try {
      signal.throwIfAborted();
      const reproducedCases = workspaceAcceptanceCases(goal);
      requireAffectedAcceptanceForMemberChange(
        goal.affectedAcceptance,
        !!(goal.memberAdditions?.length || goal.memberUpgrades?.length),
      );
      assertWorkspaceCaseCoverage(goal.affectedAcceptance, reproducedCases);
      await verifyViaIsolatedWorkspace(
        this.workspace,
        base,
        reproducedCases,
        signal,
        (receipt) => reproductionCases.push(receipt),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof BusinessAssertionError)) throw error;
      return reproduced(error.message);
    }
    const runtime = await this.workspace.release.start(base);
    const abort = () => {
      void runtime.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const definition = await runtime.invoke<WorkflowDefinition>("describe");
      try {
        await verifyWorkflow(runtime, definition, base, goal);
        if (plan.extensions) await verifyExtensions(runtime, plan.extensions);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof BusinessAssertionError)) throw error;
        return reproduced(error.message);
      }
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      await runtime.close();
    }
  }
  target(plan: InvestigatedPlan): Target {
    const base = this.workspace.release.get(plan.baseVersion!);
    const priorCapabilities =
      (
        base.evidence as {
          capabilities?: {
            capability: string;
            provider: string;
            consumers: string[];
          }[];
        }
      ).capabilities ?? [];
    const capabilities = [
      ...plan.capabilityChanges,
      ...priorCapabilities
        .filter(
          (old) =>
            !plan.capabilityChanges.some(
              (c) => c.capability === old.capability,
            ),
        )
        .map((old) => ({
          capability: old.capability,
          provider: old.provider,
          consumers: old.consumers,
          change: "保留已有能力",
        })),
    ];
    return {
      kind: "plugin",
      baseVersion: plan.baseVersion!,
      payload: {
        pluginId: base.pluginId,
        name: base.name,
        ...(plan.memberEnabled ? { memberEnabled: plan.memberEnabled } : {}),
        repairEvidence: plan.repairEvidence,
        acceptanceRevision: plan.acceptanceRevision,
        fields: plan.workflowRules,
        extensions: plan.extensions,
        scope: plan.writableScope,
        capabilities,
        ...(plan.memberAdditions?.length
          ? { memberAdditions: plan.memberAdditions }
          : {}),
        ...(plan.memberUpgrades?.length
          ? { memberUpgrades: plan.memberUpgrades }
          : {}),
        ...(plan.memberCases?.length ? { memberCases: plan.memberCases } : {}),
        ...(plan.affectedAcceptance
          ? { affectedAcceptance: plan.affectedAcceptance }
          : {}),
      },
    };
  }
  check(target: Target, revision: number) {
    if (
      this.workspace.composition().revision !== revision ||
      this.workspace.activeVersion().id !== target.baseVersion
    )
      throw new AppError("PLAN_STALE", "基础版本已变化，请重新规划并确认", 409);
  }
  isActiveVersion(versionId: string) {
    return this.workspace.activeVersion().id === versionId;
  }
  isReadyVersion(versionId: string) {
    return (
      this.isActiveVersion(versionId) &&
      this.workspace.composition().status === "ready"
    );
  }
  acceptanceEvidence(versionId: string) {
    const version = this.workspace.release.get(versionId);
    const evidence = version.evidence as {
      checks?: string[];
      members?: unknown;
    };
    return {
      members: version.members ?? evidence.members,
      workspaceChecks: (evidence.checks ?? []).filter((check) =>
        check.startsWith("workspace:"),
      ),
    };
  }
  generation(target: Target) {
    const base = this.workspace.release.get(target.baseVersion);
    return {
      contract,
      source: base.source,
      instruction: (target.payload as Goal).memberEnabled
        ? `The frozen plan only changes member enabled status: ${JSON.stringify((target.payload as Goal).memberEnabled)}. Read read_contract and read_current_source, then submit_candidate with {source: read_current_source.source} byte-for-byte unchanged, no members or files. The host records and validates the status candidate; never edit implementation, acceptance or publish.`
        : `Implement the frozen plan using submit_candidate with files [{path,content}] and optional members [{pluginId,source}] when the plan declares memberAdditions or memberUpgrades. Read read_contract and read_current_source first. When upgrading an existing auxiliary member, call read_member with that pluginId and its exact versionId from the frozen composition before rewriting. The business artifact requires business/entry.ts (default Plugin), business/view.ts (default JSON serializable presentation {title,fields:string[]}), business/config.json (business data only), business/compatibility.json ({"preserveUnknownFields":true}), and optional business/*.ts providers/interfaces. Only exact planned writable paths are allowed. Only the workflow files receive business/contract.ts from the trusted host; never submit it. Workflow files may use type imports from ./contract.js and other imports may only be relative './*.js' resolving within submitted TS files; no runtime dependencies, IO, globals, eval, any or enum. Config can be represented in a typed business module when used; JSON config and compatibility are versioned data, not scripts. Keep pluginId, name, existing states/actions, fields and unknown task.fields. workflowRules require trimmed Unicode lengths and required-input form on complete; reopen preserves fields. Any action requiring user input must return input-required with its declared field keys and labels when those input keys are absent, so the host action form can collect values; explicitly supplied invalid values must still reject. extensions define additional actions/fields with frozen cases; implement all of them, do not weaken cases. Frozen memberCases are isolated Workspace assertions for auxiliary members (target member, action, initial data, input, expected final data or reject); implement them, do not rely on smoke. view fields must exactly match describe().fields keys in order. Auxiliary members[].source is a separate self-contained module, not a workflow Plugin and not linked to files: no imports or re-exports (including import type or ./contract.js). Use plain JavaScript or inline erasable types. Export contribute/decide as needed; register the frozen member actions in contribute.commands. Do not describe a second workflow. UI slots are optional because the host renders declared actions and input-required forms; if present, only slot "task.detail" is supported. When memberAdditions is set, submit exactly those pluginIds as members with complete JavaScript module source (export default plugin with contribute/decide as needed); host records them as new auxiliary members. When memberUpgrades is set, submit exactly those existing auxiliary pluginIds with replacement source; host records new versionIds and inherits unmodified members with exact versionId/enabled/role. If only upgrading auxiliaries and the workflow source is unchanged from the base, preserve the exact source; for a file-bundle plan submit its parsed files without edits (the source field is only allowed when exposed by submit_candidate), so the host can pin the workflow member to the exact base versionId. Host builds and independently checks; repair real errors within scope. report_blocker if scope/control changes are necessary. Never publish or invent a pass report. Successful validation waits for user apply.`,
    };
  }
  readMember(pluginId: string, versionId: string) {
    const composition = this.workspace.composition();
    const member = composition.members.find(
      (m) => m.pluginId === pluginId && m.versionId === versionId,
    );
    if (!member)
      throw new AppError(
        "UNKNOWN_PLUGIN",
        `活动组合中不存在成员 ${pluginId}@${versionId}`,
      );
    const version = this.workspace.release.get(versionId);
    if (version.pluginId !== pluginId)
      throw new AppError(
        "EXTENSION_CONFLICT",
        `成员身份与版本不一致：${pluginId}`,
      );
    const acceptance = this.workspace.activeVersion().evidence as {
      memberCases?: { member?: string }[];
    };
    const memberCases = Array.isArray(acceptance.memberCases)
      ? acceptance.memberCases
      : [];
    return {
      pluginId,
      versionId,
      source: version.source,
      contract: JSON.stringify(version.definition ?? { id: pluginId }),
      acceptance: JSON.stringify(
        memberAcceptancePayload(
          pluginId,
          versionId,
          member.role,
          version.evidence,
          memberCases,
        ),
      ),
    };
  }
  async candidate(
    source: string,
    target: Target,
    signal: AbortSignal,
    stage: (label: string) => void,
  ) {
    const base = this.workspace.release.get(target.baseVersion);
    const goal = target.payload as Goal;
    if (goal.memberEnabled) {
      signal.throwIfAborted();
      this.check(target, this.workspace.composition().revision);
      const submitted = splitCandidateSubmission(source);
      if (submitted.workflowSource !== base.source || submitted.members.length)
        throw new ProtectedCandidateError("启停候选禁止修改源码或成员实现");
      stage("验证辅助成员启用状态候选");
      const version = this.workspace.recordMemberEnabledVersion(goal.memberEnabled.pluginId, goal.memberEnabled.enabled);
      // Existing host checks validate the exact before/after member lock and unchanged implementation.
      if (!this.memberEnabledExperience(version, "enable-status-check"))
        throw new ProtectedCandidateError("启停候选不是纯状态变更");
      return version.id;
    }
    if (
      goal.repairEvidence &&
      (goal.repairEvidence.baseVersion !== base.id ||
        goal.repairEvidence.definitionHash !==
          acceptanceDefinitionHash(goal))
    )
      throw new ProtectedCandidateError("修复断言与旧版证据不一致");
    stage("构建候选");
    const { workflowSource, members: submittedMembers } =
      splitCandidateSubmission(source);
    const plannedAdditions = goal.memberAdditions ?? [];
    const plannedUpgrades = goal.memberUpgrades ?? [];
    if (plannedAdditions.length && plannedUpgrades.length)
      throw new ProtectedCandidateError("同一候选不能同时新增与升级辅助成员");
    const plannedMemberIds = [
      ...plannedAdditions.map((m) => m.pluginId),
      ...plannedUpgrades.map((m) => m.pluginId),
    ].sort();
    const submittedIds = submittedMembers.map((m) => m.pluginId).sort();
    if (
      plannedMemberIds.length !== submittedIds.length ||
      plannedMemberIds.some((id, i) => id !== submittedIds[i])
    )
      throw new ProtectedCandidateError("成员提交与冻结计划不一致");
    if (
      !workflowSource.startsWith('{"files":') &&
      (!goal.scope?.includes("active-source") || !!base.bundle)
    )
      throw new ProtectedCandidateError(
        "单源码入口未获冻结范围授权，请提交完整候选文件",
      );
    const pinWorkflow = workflowUnchangedForUpgrade(
      base,
      goal,
      workflowSource,
      plannedAdditions,
      plannedUpgrades,
    );
    const pinWorkflowVersionId = pinWorkflow ? base.id : undefined;
    let code: string;
    let bundle: Version["bundle"];
    let definition: WorkflowDefinition;
    let recordSource = workflowSource;
    if (pinWorkflow) {
      code = base.code;
      bundle = base.bundle;
      definition = base.definition as WorkflowDefinition;
      recordSource = base.source;
    } else {
      const files = workflowSource.startsWith('{"files":')
        ? parseBusinessFiles(
            (JSON.parse(workflowSource) as { files: unknown }).files,
          )
        : {
            "business/entry.ts": workflowSource,
            "business/view.ts": `export default ${JSON.stringify({ title: goal.name, fields: goal.fields.map((f) => f.key) })};`,
            "business/config.json": "{}",
            "business/compatibility.json": '{"preserveUnknownFields":true}',
          };
      if (
        workflowSource.startsWith('{"files":') &&
        goal.scope &&
        [
          ...new Set([
            ...Object.keys(files),
            ...Object.keys(base.bundle?.files ?? {}),
          ]),
        ].some(
          (path) =>
            path !== "business/contract.ts" &&
            !goal.scope!.includes(path) &&
            files[path] !== base.bundle?.files[path],
        )
      )
        throw new ProtectedCandidateError(
          "候选超出冻结可写范围，必须重新 Plan 和 start",
        );
      const built = await this.workspace.release.buildBundle(
        files,
        contract,
        signal,
      );
      code = built.outputs["business/entry.js"];
      bundle = built;
      definition = {
        ...(base.definition as WorkflowDefinition),
        id: goal.pluginId,
        name: goal.name,
        version: "generated",
        actions: [
          ...(base.definition as WorkflowDefinition).actions,
          ...(goal.extensions?.actions ?? []).filter(
            (a) =>
              !(base.definition as WorkflowDefinition).actions.some(
                (old) => old.id === a.id,
              ),
          ),
        ],
        fields: [
          ...goal.fields.map((f) => ({
            key: f.key,
            label: f.label,
            type: "text" as const,
            required: f.required,
          })),
          ...(goal.extensions?.fields ?? []),
        ],
      };
    }
    signal.throwIfAborted();
    const addedMembers: VersionMember[] = [];
    const upgradedMembers: VersionMember[] = [];
    const draftChanges: DraftMemberChange[] = [];
    for (const planned of plannedAdditions) {
      const submitted = submittedMembers.find(
        (m) => m.pluginId === planned.pluginId,
      );
      if (!submitted)
        throw new ProtectedCandidateError("成员提交与冻结计划不一致");
      const draft = await this.recordMemberDraft(
        {
          kind: "addition",
          planned,
          submitted,
          baseId: base.id,
        },
        signal,
      );
      draftChanges.push({
        kind: "addition",
        planned,
        submitted,
        draft,
      });
      addedMembers.push({
        pluginId: draft.pluginId,
        versionId: draft.id,
        enabled: true,
        role: "auxiliary",
      });
    }
    for (const planned of plannedUpgrades) {
      const submitted = submittedMembers.find(
        (m) => m.pluginId === planned.pluginId,
      );
      if (!submitted)
        throw new ProtectedCandidateError("成员提交与冻结计划不一致");
      const prior = resolveVersionMembers(base).find(
        (m) => m.pluginId === planned.pluginId,
      );
      if (!prior || prior.role !== "auxiliary")
        throw new ProtectedCandidateError("只能升级活动组合中的辅助成员");
      const priorVersion = this.workspace.release.get(
        prior.versionId ?? base.id,
      );
      const draft = await this.recordMemberDraft(
        {
          kind: "upgrade",
          planned,
          submitted,
          baseId: base.id,
          priorVersion,
        },
        signal,
      );
      draftChanges.push({
        kind: "upgrade",
        planned,
        submitted,
        draft,
        prior,
        priorVersion,
      });
      upgradedMembers.push({
        pluginId: draft.pluginId,
        versionId: draft.id,
        enabled: prior.enabled,
        role: "auxiliary",
      });
    }
    const members = composeCandidateMembers(
      base,
      goal.pluginId,
      addedMembers,
      upgradedMembers,
      pinWorkflowVersionId,
    );
    validateCompositionMembers(
      { ...base, pluginId: goal.pluginId, name: goal.name, members },
      (id) => this.workspace.release.get(id),
    );
    const candidate = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: base.pluginId === goal.pluginId ? base.id : undefined,
      service: "workflow",
      contractVersion: "workflow/1",
      source: recordSource,
      code,
      ...(bundle ? { bundle } : {}),
      definition,
      evidence: { passed: false, rules: goal.fields },
      members,
    });
    stage("验证行为");
    let actual: WorkflowDefinition = definition;
    let checks: string[] = [];
    let systemChecks: string[] = [];
    let capabilities: unknown[] = [];
    const verifyGoal = pinWorkflowVersionId
      ? {
          ...goal,
          name: (base.definition as WorkflowDefinition).name,
          fields: goal.fields,
        }
      : goal;
    const prepared = await this.workspace.release
      .prepare(candidate, async (runtime) => {
        const abort = () => {
          void runtime.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          actual = await runtime.invoke<WorkflowDefinition>("describe");
          if (bundle) {
            const info = await runtime.invoke<{
              presentation: { title: string; fields: string[] };
              modules: { path: string; status: string; exports: string[] }[];
            }>("__business_info");
            if (
              !info ||
              typeof info.presentation?.title !== "string" ||
              !equal(
                info.presentation.fields,
                actual.fields.map((f) => f.key),
              )
            )
              throw new Error("前端资源与业务接口字段不一致");
            capabilities = (goal.capabilities ?? []).map((c) => {
              const provider =
                c.provider === "active-source"
                  ? "business/entry.ts"
                  : c.provider;
              if (!provider.startsWith("business/"))
                return {
                  id: hash({
                    pluginId: goal.pluginId,
                    capability: c.capability,
                  }),
                  declared: true,
                  ready: false,
                  provider,
                };
              const module = info.modules.find(
                (m) => m.path === provider.replace(/\.ts$/, ".js"),
              );
              if (
                !module ||
                module.status !== "evaluated" ||
                !module.exports.length
              )
                throw new Error(`能力提供者未实际加载：${provider}`);
              return {
                id: hash({
                  pluginId: goal.pluginId,
                  capability: c.capability,
                }),
                capability: c.capability,
                provider,
                version: hash(
                  bundle.outputs[provider.replace(/\.ts$/, ".js")],
                ),
                interface: module.exports,
                dependencies: [
                  ...bundle.files[provider].matchAll(
                    /from\s*["']([^"']+)["']/g,
                  ),
                ].map((m) => m[1]),
                consumers: c.consumers,
                declared: true,
                ready: true,
                evidence: candidate.id,
              };
            });
          } else {
            capabilities = (goal.capabilities ?? []).map((c) => ({
              id: hash({ pluginId: goal.pluginId, capability: c.capability }),
              declared: true,
              ready: false,
              provider: c.provider,
            }));
          }
          systemChecks = await verifyProtection(runtime, actual);
          if (pinWorkflowVersionId) {
            checks.push("workflow:pinned-unchanged");
          } else {
            checks = await verifyWorkflow(runtime, actual, base, verifyGoal);
            if (goal.extensions)
              checks.push(
                ...(await verifyExtensions(runtime, goal.extensions)),
              );
          }
          for (const member of [...addedMembers, ...upgradedMembers]) {
            signal.throwIfAborted();
            if (!member.enabled) {
              checks.push(`member.upgraded:${member.pluginId}:disabled`);
              continue;
            }
            const decision = await runtime.invoke<WorkflowDecision>(
              "decide",
              {
                task: {
                  id: "member-oracle",
                  title: "Member probe",
                  description: "",
                  state: "open",
                  revision: 1,
                  createdAt: "2026-01-01",
                  updatedAt: "2026-01-01",
                  deletedAt: null,
                  fields: {},
                } satisfies Task,
                action: "__host_unknown_action",
                input: {},
              },
              member.pluginId,
            );
            if (decision.kind !== "reject")
              throw new Error(`成员未正确装载：${member.pluginId}`);
            const kind = addedMembers.some((m) => m.pluginId === member.pluginId)
              ? "added"
              : "upgraded";
            checks.push(`member.${kind}:${member.pluginId}`);
          }
          if (
            goal.affectedAcceptance &&
            [...addedMembers, ...upgradedMembers].some((m) => m.enabled)
          ) {
            signal.throwIfAborted();
            const priorCommands = new Map<string, string[]>();
            if (plannedUpgrades.length) {
              const baseRuntime = await this.workspace.release.start(base);
              try {
                for (const planned of plannedUpgrades) {
                  const prior = await baseRuntime
                    .invoke<ExtensionContribution>(
                      "contribute",
                      undefined,
                      planned.pluginId,
                    )
                    .catch(() => emptyContribution());
                  priorCommands.set(
                    planned.pluginId,
                    (prior.commands ?? []).map((c) => c.id),
                  );
                }
              } finally {
                await baseRuntime.close();
              }
            }
            for (const member of [...addedMembers, ...upgradedMembers]) {
              if (!member.enabled) continue;
              const target = goal.affectedAcceptance.targets.find(
                (t) => t.pluginId === member.pluginId,
              );
              const contribution = await runtime
                .invoke<ExtensionContribution>(
                  "contribute",
                  undefined,
                  member.pluginId,
                )
                .catch(() => emptyContribution());
              const registered = (contribution.commands ?? []).map((c) => c.id);
              const known = new Set(registered);
              const { valid: uiContributions, faults } = resolveUiContributions(
                contribution,
                known,
                member.pluginId,
              );
              if (faults.length)
                throw new Error(
                  `成员 UI 贡献无效：${member.pluginId}；${faults.map((f) => f.reason).join("；")}`,
                );
              void uiContributions;
              const unauthorized = unauthorizedMemberCommands({
                registered,
                authorized: target?.actions ?? [],
                ...(upgradedMembers.some((m) => m.pluginId === member.pluginId)
                  ? { prior: priorCommands.get(member.pluginId) ?? [] }
                  : {}),
              });
              if (unauthorized.length)
                throw new Error(
                  `未授权动作：成员 ${member.pluginId} 注册了计划未覆盖的命令 ${unauthorized.join("、")}，请重新规划并提交对应冻结案例`,
                );
              checks.push(`member.authorized:${member.pluginId}`);
            }
          }
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      })
      .catch((error: unknown) => {
        throw new CandidateValidationError(
          error instanceof Error ? error.message : "候选验证失败",
          candidate.id,
        );
      });
    await prepared.runtime.close();
    const workspaceCasesEvidence: WorkspaceCaseEvidence[] = [];
    // Decide-level checks are a fast pre-layer; trusted completion requires
    // isolated Workspace command → beforeCommit → query final facts.
    try {
      signal.throwIfAborted();
      const workspaceCases = workspaceAcceptanceCases(verifyGoal);
      requireAffectedAcceptanceForMemberChange(
        verifyGoal.affectedAcceptance,
        [...addedMembers, ...upgradedMembers].some((m) => m.enabled),
      );
      assertWorkspaceCaseCoverage(verifyGoal.affectedAcceptance, workspaceCases);
      checks.push(
        ...(await verifyViaIsolatedWorkspace(
          this.workspace,
          candidate,
          workspaceCases,
          signal,
          (receipt) => workspaceCasesEvidence.push(receipt),
        )),
      );
    } catch (error: unknown) {
      const { id: _id, entry: _entry, createdAt: _createdAt, ...artifact } = candidate;
      const failed = this.workspace.release.record({
        ...artifact,
        evidence: { passed: false, rules: goal.fields, workspaceCases: workspaceCasesEvidence },
      });
      throw new CandidateValidationError(
        error instanceof Error ? error.message : "候选验证失败",
        failed.id,
      );
    }
    const verifiedAdditions: VersionMember[] = [];
    const verifiedUpgrades: VersionMember[] = [];
    for (const change of draftChanges) {
      const verifiedMember = this.recordMemberVerified(change, base.id, candidate.id);
      if (change.kind === "addition")
        verifiedAdditions.push({
          pluginId: verifiedMember.pluginId,
          versionId: verifiedMember.id,
          enabled: true,
          role: "auxiliary",
        });
      else
        verifiedUpgrades.push({
          pluginId: verifiedMember.pluginId,
          versionId: verifiedMember.id,
          enabled: change.prior.enabled,
          role: "auxiliary",
        });
    }
    const verifiedMembers = composeCandidateMembers(
      base,
      goal.pluginId,
      verifiedAdditions,
      verifiedUpgrades,
      pinWorkflowVersionId,
    );
    validateCompositionMembers(
      {
        ...base,
        pluginId: goal.pluginId,
        name: goal.name,
        members: verifiedMembers,
      },
      (id) => this.workspace.release.get(id),
    );
    const verified = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: candidate.parentId,
      service: "workflow",
      contractVersion: "workflow/1",
      source: recordSource,
      code,
      ...(bundle ? { bundle } : {}),
      definition: actual,
      evidence: {
        passed: true,
        acceptanceRevision: goal.acceptanceRevision,
        repairEvidence: goal.repairEvidence,
        rules: goal.fields,
        extensions: goal.extensions,
        memberAdditions: plannedAdditions,
        memberUpgrades: plannedUpgrades,
        memberCases: goal.memberCases,
        workspaceCases: workspaceCasesEvidence,
        checks,
        systemChecks,
        capabilities,
        definitionHash: acceptanceDefinitionHash(goal),
        environment: {
          node: process.version,
          lockHash: bundle?.lockHash ?? null,
          builder: bundle?.builder ?? null,
        },
        verifier: "workspace/1",
        baseVersion: base.id,
        members: verifiedMembers,
        ...(pinWorkflowVersionId
          ? { pinnedWorkflowVersionId: pinWorkflowVersionId }
          : {}),
      },
      members: verifiedMembers,
    });
    return verified.id;
  }
  private buildMemberBundle(source: string): BusinessBundle {
    return synthesizeMemberBundle(source);
  }
  private async recordMemberDraft(
    input:
      | {
          kind: "addition";
          planned: MemberAddition;
          submitted: SubmittedMember;
          baseId: string;
        }
      | {
          kind: "upgrade";
          planned: MemberUpgrade;
          submitted: SubmittedMember;
          baseId: string;
          priorVersion: Version;
        },
    _signal: AbortSignal,
  ): Promise<Version> {
    const bundle = this.buildMemberBundle(input.submitted.source);
    const code = bundle.outputs["business/entry.js"];
    if (!code)
      throw new ProtectedCandidateError("辅助成员可信构建缺少入口产物");
    if (input.kind === "addition")
      return this.workspace.release.record({
        pluginId: input.planned.pluginId,
        name: input.planned.name,
        service: `plugin:${input.planned.pluginId}`,
        contractVersion: "extensions/1",
        source: input.submitted.source,
        code,
        bundle,
        definition: { id: input.planned.pluginId },
        evidence: {
          passed: false,
          generated: true,
          origin: "evolution-member-addition",
          baseVersion: input.baseId,
        },
      });
    return this.workspace.release.record({
      pluginId: input.planned.pluginId,
      name: input.priorVersion.name,
      service: input.priorVersion.service,
      contractVersion: input.priorVersion.contractVersion,
      source: input.submitted.source,
      code,
      bundle,
      definition: input.priorVersion.definition,
      evidence: {
        passed: false,
        generated: true,
        origin: "evolution-member-upgrade",
        baseVersion: input.baseId,
        priorVersionId: input.priorVersion.id,
      },
    });
  }
  private recordMemberVerified(
    change: DraftMemberChange,
    baseId: string,
    candidateId: string,
  ): Version {
    const bundle = change.draft.bundle;
    const code = change.draft.code;
    if (!bundle?.outputs["business/entry.js"])
      throw new ProtectedCandidateError("辅助成员缺少可信构建产物，不能记通过版");
    if (change.kind === "addition")
      return this.workspace.release.record({
        pluginId: change.planned.pluginId,
        name: change.planned.name,
        service: `plugin:${change.planned.pluginId}`,
        contractVersion: "extensions/1",
        source: change.submitted.source,
        code,
        bundle,
        definition: { id: change.planned.pluginId },
        evidence: {
          passed: true,
          generated: true,
          origin: "evolution-member-addition",
          baseVersion: baseId,
          draftVersion: change.draft.id,
          candidateId,
        },
      });
    return this.workspace.release.record({
      pluginId: change.planned.pluginId,
      name: change.priorVersion.name,
      service: change.priorVersion.service,
      contractVersion: change.priorVersion.contractVersion,
      source: change.submitted.source,
      code,
      bundle,
      definition: change.priorVersion.definition,
      evidence: {
        passed: true,
        generated: true,
        origin: "evolution-member-upgrade",
        baseVersion: baseId,
        draftVersion: change.draft.id,
        candidateId,
        priorVersionId: change.priorVersion.id,
      },
    });
  }
  async experience(
    versionId: string,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<ExperienceReport> {
    const version = this.workspace.release.get(versionId);
    const memberExperience = this.memberEnabledExperience(
      version,
      candidateId,
    );
    if (memberExperience) return memberExperience;
    const runtime = await this.workspace.release.start(version);
    try {
      signal.throwIfAborted();
      const definition = await runtime.invoke<WorkflowDefinition>("describe");
      let presentation = {
        title: definition.name,
        fields: definition.fields.map((f) => f.label),
      };
      try {
        const info = await runtime.invoke<{
          presentation?: { title: string; fields: string[] };
        } | null>("__business_info");
        if (info?.presentation?.title)
          presentation = {
            title: info.presentation.title,
            fields: info.presentation.fields ?? [],
          };
      } catch {
        // File-entry fixtures may omit business/view; UI contributions stay separate.
      }
      const contribution = await runtime
        .invoke<ExtensionContribution>("contribute")
        .catch(() => emptyContribution());
      const known = new Set([
        ...definition.actions.map((a) => a.id),
        ...(contribution.commands ?? []).map((c) => c.id),
      ]);
      const { valid: uiContributions } = resolveUiContributions(
        contribution,
        known,
        version.pluginId,
      );
      const sample = await runtime.invoke<WorkflowDecision>("decide", {
        task: {
          state: definition.initialState,
          fields: { retained: "preview-only" },
        },
        action: "complete",
        input: {},
      });
      const checks = [
        `describe:${definition.id}`,
        `presentation:${presentation.title}`,
        `fields:${presentation.fields.join(",")}`,
        `decide:${sample.kind}`,
      ];
      if (uiContributions.length) {
        checks.push("ui.slot:active");
        const proof = uiContributions[0]!;
        checks.push(`ui.contribution:${proof.id}`);
        const action = proof.actions[0];
        if (action) {
          checks.push(`ui.action:${action.commandId}`);
          signal.throwIfAborted();
          const write = await runtime.invoke<WorkflowDecision>("decide", {
            task: {
              id: "experience-task",
              title: "体验任务",
              description: "",
              state: definition.initialState,
              revision: 1,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
              deletedAt: null,
              fields: { retained: "preview-only" },
            } satisfies Task,
            action: action.commandId,
            input: {},
          });
          checks.push(
            write.kind === "commit"
              ? `ui.write:commit`
              : `ui.write:${write.kind}`,
          );
        }
      }
      const evidence = version.evidence as { extensions?: BusinessExtensions };
      if (evidence.extensions) {
        signal.throwIfAborted();
        checks.push(
          ...(await verifyExtensions(runtime, evidence.extensions)).map(
            (name) => `extension:${name}`,
          ),
        );
      }
      signal.throwIfAborted();
      return {
        candidateId,
        marked: "not-applied",
        isolated: true,
        simulated: true,
        checks,
        presentation,
        ...(uiContributions.length ? { uiContributions } : {}),
        note: "候选体验使用隔离环境与模拟数据，结果已标注为尚未应用，未写入正式任务。",
      };
    } finally {
      await runtime.close();
    }
  }
  /** Composition-level summary when the candidate only flips member enabled flags. */
  private memberEnabledExperience(
    version: Version,
    candidateId: string,
  ): ExperienceReport | undefined {
    if (!version.parentId) return undefined;
    let base: Version;
    try {
      base = this.workspace.release.get(version.parentId);
    } catch {
      return undefined;
    }
    if (this.workspace.activeVersion().id !== base.id)
      throw new AppError(
        "PLAN_STALE",
        "基础版本已变化，请重新规划并确认",
        409,
      );
    if (
      version.pluginId !== base.pluginId ||
      version.source !== base.source ||
      version.code !== base.code ||
      version.service !== base.service ||
      version.contractVersion !== base.contractVersion ||
      !equal(version.definition, base.definition) ||
      !equal(version.evidence, base.evidence) ||
      !equal(version.bundle, base.bundle)
    )
      return undefined;
    const baseMembers = resolveVersionMembers(base);
    const before = new Map(
      baseMembers.map((m) => [m.pluginId, m.enabled] as const),
    );
    const after = resolveVersionMembers(version);
    if (
      before.size !== after.length ||
      after.some((member) => !before.has(member.pluginId))
    )
      return undefined;
    const flips = after.filter(
      (member) => before.get(member.pluginId) !== member.enabled,
    );
    if (!flips.length) return undefined;
    if (
      after.some((member) => {
        const prior = baseMembers.find((m) => m.pluginId === member.pluginId);
        if (!prior || prior.role !== member.role) return true;
        const priorVid = prior.versionId ?? base.id;
        const nextVid = member.versionId ?? version.id;
        const priorIsRoot = priorVid === base.id;
        const nextIsRoot = nextVid === version.id;
        return priorVid !== nextVid && !(priorIsRoot && nextIsRoot);
      })
    )
      return undefined;
    const checks = flips.map(
      (member) =>
        `member.enabled:${member.pluginId}:${before.get(member.pluginId)}->${member.enabled}`,
    );
    for (const member of flips) {
      checks.push(
        member.enabled
          ? `contribution.restore:${member.pluginId}`
          : `contribution.exit:${member.pluginId}`,
      );
    }
    checks.push("retained.fields:policy");
    checks.push("formal:unchanged-until-apply");
    const disabled = flips.filter((m) => !m.enabled).map((m) => m.pluginId);
    const enabled = flips.filter((m) => m.enabled).map((m) => m.pluginId);
    const titleParts = [
      ...(disabled.length ? [`停用 ${disabled.join(", ")}`] : []),
      ...(enabled.length ? [`启用 ${enabled.join(", ")}`] : []),
    ];
    return {
      candidateId,
      marked: "not-applied",
      isolated: true,
      simulated: true,
      checks,
      presentation: {
        title: `${titleParts.join("；")}（尚未应用到正式环境）`,
        fields: after.map(
          (member) =>
            `${member.pluginId}:${member.enabled ? "启用" : "停用（按保留规则）"}`,
        ),
      },
      note: `启用状态变更候选体验：摘要基于候选组合修订，结果已标注为尚未应用到正式环境；${memberEnabledDataImpact}；本体验未读写正式任务。`,
    };
  }
  async apply(
    versionId: string,
    target: Target,
    revision: number,
    operationId: string,
    complete: () => void,
    signal: AbortSignal,
  ) {
    this.check(target, revision);
    await this.workspace.activate(
      { versionId, compositionRevision: revision, operationId },
      () => {
        signal.throwIfAborted();
        complete();
      },
      signal,
    );
  }
}

/** Cases for isolated Workspace command/query acceptance (after decide pre-checks). */
export function workspaceAcceptanceCases(goal: Goal): WorkspaceAcceptanceCase[] {
  const valid = validFieldInputs(goal.fields);
  const cases: WorkspaceAcceptanceCase[] = [
    {
      name: "workspace:complete-final-fields",
      state: "open",
      fields: {},
      action: "complete",
      input: valid,
      expected: {
        kind: "commit",
        state: "done",
        fields: { ...valid },
      },
    },
  ];
  for (const f of goal.fields) {
    if (!f.required) continue;
    cases.push({
      name: `workspace:${f.key}:missing-input`,
      state: "open",
      fields: {},
      action: "complete",
      input: {},
      expected: { kind: "reject" },
    });
  }
  for (const c of goal.extensions?.cases ?? [])
    cases.push({
      name: `workspace:${c.name}`,
      state: c.state,
      fields: { ...c.fields },
      action: c.action,
      input: { ...c.input },
      expected:
        c.expected.kind === "reject"
          ? { kind: "reject" }
          : {
              kind: "commit",
              state: c.expected.state,
              fields: { ...c.expected.fields },
            },
    });
  for (const c of goal.memberCases ?? [])
    cases.push({
      name: `workspace:member:${c.member}:${c.name}`,
      member: c.member,
      state: c.state,
      fields: { ...c.fields },
      action: c.action,
      input: { ...c.input },
      expected:
        c.expected.kind === "reject"
          ? { kind: "reject" }
          : {
              kind: "commit",
              state: c.expected.state,
              fields: { ...c.expected.fields },
            },
    });
  return cases;
}

// Host-owned oracle: frozen field rules plus existing workflow behavior, never model-written tests.
export async function verifyWorkflow(
  runtime: RuntimeLike,
  definition: WorkflowDefinition,
  base: Version,
  goal: Goal,
) {
  const expected = base.definition as WorkflowDefinition;
  if (
    definition.id !== goal.pluginId ||
    definition.name !== goal.name ||
    !definition.version ||
    definition.initialState !== expected.initialState ||
    !equal(definition.states, expected.states) ||
    !equal(definition.actions, [
      ...expected.actions,
      ...(goal.extensions?.actions ?? []).filter(
        (a) => !expected.actions.some((old) => old.id === a.id),
      ),
    ]) ||
    !equal(
      definition.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: !!f.required,
      })),
      [
        ...goal.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: "text" as const,
          required: f.required,
        })),
        ...(goal.extensions?.fields ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: !!f.required,
        })),
      ],
    )
  )
    throw new Error("工作流定义不符合已确认契约");
  const task: Task = {
    id: "oracle",
    title: "Existing item",
    description: "Preserve",
    state: "open",
    revision: 7,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    deletedAt: null,
    fields: { retained: "historical" },
  };
  const checks: string[] = [];
  const decide = (
    state: string,
    action: string,
    input: Record<string, string>,
    fields = task.fields,
  ) =>
    runtime.invoke<WorkflowDecision>("decide", {
      task: { ...task, state, fields },
      action,
      input,
    });
  const valid = validFieldInputs(goal.fields);
  const assert = (ok: boolean, name: string) => {
    if (!ok) throw new BusinessAssertionError(`行为验收失败：${name}`);
    checks.push(name);
  };
  for (const f of goal.fields) {
    if (f.required) {
      for (const value of [undefined, "", "   "]) {
        const input = { ...valid };
        if (value === undefined) delete input[f.key];
        else input[f.key] = value;
        const d = await decide("open", "complete", input, {
          ...task.fields,
          [f.key]: "已有历史文字",
        });
        assert(
          d.kind === "input-required" && d.fields.some((x) => x.key === f.key),
          `${f.key}:missing-input-form`,
        );
      }
    }
    if (f.minLength > 1) {
      const d = await decide("open", "complete", {
        ...valid,
        [f.key]: "字".repeat(f.minLength - 1),
      });
      assert(d.kind === "reject", `${f.key}:minimum`);
    }
    const d = await decide("open", "complete", {
      ...valid,
      [f.key]: "字".repeat(f.maxLength + 1),
    });
    assert(d.kind === "reject", `${f.key}:maximum`);
    const boundary = await decide("open", "complete", {
      ...valid,
      [f.key]: "🙂".repeat(f.maxLength),
    });
    assert(boundary.kind === "commit", `${f.key}:unicode-boundary`);
  }
  const d = await decide(
    "open",
    "complete",
    Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, ` ${v} `])),
  );
  assert(
    d.kind === "commit" &&
      d.state === "done" &&
      equal(d.fields, { ...task.fields, ...valid }),
    "complete-preserve-fields",
  );
  const reopened = await decide(
    "done",
    "reopen",
    {},
    { ...task.fields, ...valid },
  );
  assert(
    reopened.kind === "commit" &&
      reopened.state === "open" &&
      equal(reopened.fields, { ...task.fields, ...valid }),
    "reopen-preserve-fields",
  );
  for (const [state, action] of [
    ["done", "complete"],
    ["open", "reopen"],
    ["open", "unknown"],
  ])
    assert(
      (await decide(state, action, valid)).kind === "reject",
      `invalid:${state}:${action}`,
    );
  return checks;
}

// Independent host protection checks; candidate code cannot supply this report.
async function verifyProtection(
  runtime: RuntimeLike,
  definition: WorkflowDefinition,
) {
  if (!equal(await runtime.invoke("describe"), definition))
    throw new Error("保护验收失败：业务定义不稳定");
  let rejected = false;
  try {
    await runtime.invoke("__host_unknown_method");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("保护验收失败：未知方法未拒绝");
  for (const state of Object.keys(definition.states)) {
    const result = await runtime.invoke<WorkflowDecision>("decide", {
      task: { id: "protected", state, fields: { retained: "keep" } },
      action: "__host_unknown_action",
      input: {},
    });
    if (result.kind !== "reject")
      throw new Error("保护验收失败：未知动作未拒绝");
  }
  return [
    "deterministic-definition",
    "unknown-method-rejected",
    "unknown-actions-rejected",
    "json-only-runtime-boundary",
  ];
}
