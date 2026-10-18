import { hash } from "../release/storage.js";
import type { AcceptanceObligation } from "../shared/acceptance-obligations.js";
import type { InvestigatedPlan } from "../shared/assistant.js";
import type { BrowserStep } from "../shared/browser-cases.js";

export type ActionAvailability = {
  version: 1;
  baseVersion: string;
  revision: number;
  rendererHash: string;
  initialState: string;
  states: string[];
  actions: {
    member: string;
    contribution: string;
    action: string;
    from: string[];
    providerVersion: string;
  }[];
  hash: string;
};
type SnapshotInput = Omit<
  ActionAvailability,
  "version" | "hash" | "actions"
> & {
  workflowProvider: string;
  members: { pluginId: string; versionId: string; enabled: boolean }[];
  actions: { id: string; providerId?: string; from: string[] }[];
  contributions: {
    id: string;
    providerId: string;
    actions: { commandId: string }[];
  }[];
};

/** Capture exactly the state filtering and contribution routing used by the host renderer. */
export function captureAvailability(input: SnapshotInput): ActionAvailability {
  const actions: ActionAvailability["actions"] = [];
  for (const action of input.actions) {
    const provider = action.providerId ?? input.workflowProvider;
    const member = input.members.find(
      (m) => m.pluginId === provider && m.enabled,
    );
    if (!member) throw new Error("动作可见性缺少精确活动成员事实");
    const contributions = input.contributions.filter(
      (c) =>
        c.providerId === provider &&
        c.actions.some((a) => a.commandId === action.id),
    );
    for (const contribution of contributions.length
      ? contributions
      : provider === input.workflowProvider
        ? [{ id: "workflow" }]
        : [])
      actions.push({
        member: provider === input.workflowProvider ? "workflow" : provider,
        contribution: contribution.id,
        action: action.id,
        from: [...action.from].sort(),
        providerVersion: member.versionId,
      });
  }
  const body = {
    version: 1 as const,
    baseVersion: input.baseVersion,
    revision: input.revision,
    rendererHash: input.rendererHash,
    initialState: input.initialState,
    states: [...input.states].sort(),
    actions: actions.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
  };
  return { ...body, hash: hash(body) };
}
export function availabilitySnapshotValid(snapshot: ActionAvailability) {
  const { hash: digest, ...body } = snapshot;
  return (
    snapshot.version === 1 &&
    hash(body) === digest &&
    snapshot.states.includes(snapshot.initialState)
  );
}
export function availabilityFacts(snapshot: ActionAvailability | undefined) {
  if (!snapshot) return [];
  if (!availabilitySnapshotValid(snapshot))
    throw new Error("动作可见性基线摘要无效");
  return snapshot.actions.flatMap((action) =>
    snapshot.states.map((state) => {
      const fact = {
        id:
          "host-fact:baseline-action:" +
          hash({
            member: action.member,
            contribution: action.contribution,
            action: action.action,
            state,
          }).slice(0, 24),
        properties: {
          member: action.member,
          contribution: action.contribution,
          action: action.action,
          state,
          visible: String(action.from.includes(state)),
          origin: "host-baseline",
          baselineHash: snapshot.hash,
          baseVersion: snapshot.baseVersion,
          providerVersion: action.providerVersion,
        },
      };
      return { ...fact, evidenceHash: hash(fact) };
    }),
  );
}
function assertionState(
  steps: BrowserStep[],
  snapshot: ActionAvailability,
): string | undefined {
  let state = snapshot.initialState;
  for (const step of steps) {
    if (
      step.kind === "open" ||
      step.kind === "refresh" ||
      step.kind === "restart"
    )
      continue;
    // Only the existing workflow/1 finite complete/reopen contract can prove this preparation.
    if (
      step.kind !== "action" ||
      step.member !== "workflow" ||
      !["complete", "reopen"].includes(step.action)
    )
      return;
    const action = snapshot.actions.find(
      (a) =>
        a.member === "workflow" &&
        a.action === step.action &&
        a.from.includes(state),
    );
    if (!action) return;
    state = step.action === "complete" ? "done" : snapshot.initialState;
    if (!snapshot.states.includes(state)) return;
  }
  return state;
}
export function inheritedAvailability(
  o: AcceptanceObligation,
  snapshot: ActionAvailability | undefined,
) {
  if (
    o.kind !== "assertion" ||
    o.expected.kind !== "action-visible" ||
    !snapshot ||
    !availabilitySnapshotValid(snapshot)
  )
    return;
  const state = assertionState(o.steps, snapshot);
  if (!state) return;
  const expected = o.expected;
  const matches = snapshot.actions.filter(
    (a) =>
      a.member === expected.member &&
      a.action === expected.action &&
      (!expected.contribution || a.contribution === expected.contribution),
  );
  if (
    matches.length !== 1 ||
    matches[0].from.includes(state) !== expected.visible
  )
    return;
  return { origin: "host" as const, state };
}
/** Binding is host-owned. Merely declaring origin=host never grants an exemption. */
export function isInheritedAvailability(
  o: AcceptanceObligation,
  snapshot: ActionAvailability | undefined,
) {
  return (
    o.kind === "assertion" &&
    !!o.availability &&
    hash(o.availability) === hash(inheritedAvailability(o, snapshot))
  );
}
export function bindAvailability(
  requirements: NonNullable<InvestigatedPlan["requirements"]>,
  snapshot: ActionAvailability | undefined,
) {
  for (const r of requirements)
    for (const o of r.obligations ?? []) {
      if (o.kind !== "assertion" || o.expected.kind !== "action-visible")
        continue;
      const proof = inheritedAvailability(o, snapshot);
      if (proof) o.availability = proof;
      else delete o.availability;
    }
}
export function availabilityFailure(
  plan: Pick<
    InvestigatedPlan,
    "requirements" | "binding" | "baseVersion" | "compositionRevision"
  >,
): string | undefined {
  const snapshot = plan.binding?.actionAvailability;
  if (
    snapshot &&
    (!availabilitySnapshotValid(snapshot) ||
      snapshot.baseVersion !== plan.baseVersion ||
      snapshot.revision !== plan.compositionRevision)
  )
    return "动作可见性基线版本、修订或摘要已变化，请重新规划";
  for (const r of plan.requirements ?? [])
    for (const o of r.obligations ?? []) {
      if (o.kind !== "assertion" || o.expected.kind !== "action-visible")
        continue;
      if (o.availability && !isInheritedAvailability(o, snapshot))
        return "继承动作可见性缺少可信基线绑定，请重新规划";
      if (snapshot && inheritedAvailability(o, snapshot) && !o.availability)
        return "继承动作可见性来源被删除，请重新规划";
    }
}
