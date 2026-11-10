import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import type {
  BaselinePreparation,
  AcceptanceObligation,
} from "../shared/acceptance-obligations.js";
import type { BrowserCase, BrowserStep } from "../shared/browser-cases.js";
import { hash } from "../release/storage.js";

export class HistoricalPreparationBlocked extends Error {}

/** Over-cap browserCases and dangling browser/1 refs are host structure defects, not protocol retries. */
export class PlanStructureBlocked extends Error {}

/** Multiple reachable histories stay blocked as a plan defect. The same call ceiling may carry one corrected submission; repeating the defect or exhausting calls stops. Over-cap and dangling refs stop on the first occurrence. */
export function planningStructureTerminal(input: {
  historical: boolean;
  structural?: boolean;
  rejectionSeen: boolean;
  calls: number;
  callLimit: number;
}): boolean {
  return (
    input.structural === true ||
    input.rejectionSeen ||
    input.calls >= input.callLimit
  );
}
type Target = { member: string; field: string; contribution?: string };
type HistoricalObligation = Extract<AcceptanceObligation, { kind: "history" }>;

/** A finite graph of trusted, exact baseline transitions; no candidate cases or database seeds. */
export function historicalPreparation(
  target: Target,
  baseline: MemberAcceptanceCase[],
  baseVersion: string,
  inherited: AcceptanceObligation[] = [],
): BaselinePreparation {
  const blocked = (reason: string): never => {
    throw new HistoricalPreparationBlocked(
      `历史准备无法由基础版本唯一推导：${target.member}:${target.field}；${reason}，需要维护者补齐可信基线，不能伪造历史或降低要求`,
    );
  };
  // Previously accepted historical data keeps its original version and expectations.
  const accepted = inherited
    .filter(
      (o) =>
        (o.kind === "history" || o.kind === "field") &&
        o.member === target.member &&
        o.field === target.field &&
        o.contribution === target.contribution,
    )
    .flatMap((o) =>
      o.kind === "history" || o.kind === "field"
        ? o.history
          ? [o.history]
          : []
        : [],
    );
  if (accepted.length) {
    if (new Set(accepted.map(hash)).size !== 1) blocked("已有历史准备互相冲突");
    return structuredClone(accepted[0]);
  }
  if (!baseVersion) blocked("缺少精确基础版本");
  if (baseline.length > 256) blocked("基础案例超过有限准备目录上限");
  const commits = baseline
    .filter((c) => c.expected.kind === "commit")
    .sort((a, b) => hash(a).localeCompare(hash(b)));
  const queue: {
    state: string;
    fields: Record<string, string>;
    origins: MemberAcceptanceCase[];
  }[] = [{ state: "open", fields: {}, origins: [] }];
  const visited = new Set([hash({ state: "open", fields: {} })]);
  const results = new Map<string, BaselinePreparation>();
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    const matches = commits.filter(
      (c) => c.state === node.state && hash(c.fields) === hash(node.fields),
    );
    const transitions = new Map<string, string>();
    for (const c of matches) {
      if (c.expected.kind !== "commit") continue;
      const action = hash({
        member: c.member,
        action: c.action,
        input: c.input,
      });
      const expected = { state: c.expected.state, fields: c.expected.fields };
      const identity = hash(expected);
      if (transitions.has(action) && transitions.get(action) !== identity)
        blocked("同一动作的冻结成功期望不唯一");
      transitions.set(action, identity);
      const origins = [...node.origins, c];
      if (origins.length > 8) {
        if (!visited.has(identity)) blocked("准备路径超过八步契约");
        continue;
      }
      if (
        c.member === target.member &&
        !Object.hasOwn(node.fields, target.field) &&
        Object.hasOwn(c.expected.fields, target.field)
      ) {
        // Updates keep using the established history; they are not new seeds.
        // Continue traversing below so later frozen contradictions still block.
        const recipe: BaselinePreparation = {
          baseVersion,
          sourceHash: hash(origins),
          expected: structuredClone(expected),
          actions: origins.map((c) => ({
            kind: "action",
            member: c.member,
            action: c.action,
            input: structuredClone(c.input),
          })),
        };
        if (!results.has(identity)) results.set(identity, recipe);
      }
      if (!visited.has(identity)) {
        visited.add(identity);
        queue.push({ ...structuredClone(expected), origins });
      }
    }
  }
  if (results.size === 0)
    blocked("没有可达的冻结成功动作产生目标字段");
  if (results.size > 1) {
    // Product decision (#54): keep shortest-path degrade, do not block on
    // multiple reachable histories. Non-uniqueness of path is accepted when each
    // path is a frozen success that produces the target field; pick the shortest
    // action chain, then stable sourceHash order. True contradictions (ambiguous
    // frozen success expectation, unreachable field) still block elsewhere.
    const candidates = [...results.values()];
    const shortest = Math.min(...candidates.map((r) => r.actions.length));
    const viable = candidates.filter((r) => r.actions.length === shortest);
    viable.sort((a, b) => a.sourceHash.localeCompare(b.sourceHash));
    return viable[0];
  }
  return [...results.values()][0];
}

function matches(
  target: Target,
  step: Extract<BrowserStep, { kind: "field" }>,
) {
  return (
    target.member === step.member &&
    target.field === step.field &&
    target.contribution === step.contribution
  );
}

/** Bind supplemental historical assertions too, after all obligations are compiled, independent of requirement order. */
export function bindHistoricalCase(
  c: BrowserCase,
  histories: HistoricalObligation[],
): BrowserCase {
  if (c.obligationId || c.prepare || c.task !== "existing") return c;
  const initial: Extract<BrowserStep, { kind: "field" }>[] = [];
  for (const step of c.steps) {
    if (step.kind === "action") break;
    if (step.kind === "field") initial.push(step);
  }
  const recipes = initial.flatMap((s) =>
    histories
      .filter(
        (o) =>
          matches(o, s) &&
          s.visible !== false &&
          o.history.expected.fields[s.field] === s.value,
      )
      .map((o) => o.history),
  );
  if (!recipes.length) return c;
  if (
    new Set(recipes.map(hash)).size !== 1 ||
    initial.some(
      (s) =>
        s.visible === false || recipes[0].expected.fields[s.field] !== s.value,
    )
  )
    throw new HistoricalPreparationBlocked(
      "历史案例的字段期望无法绑定到同一个可信基础状态，不能注入字段或猜测准备步骤",
    );
  return { ...c, prepare: structuredClone(recipes[0]) };
}

/** Resolve a field assertion by its exact obligation or preparation identity, never the first field-name match. */
export function fieldCaseObligation(
  c: BrowserCase,
  step: Extract<BrowserStep, { kind: "field" }>,
  obligations: AcceptanceObligation[],
) {
  const candidates = obligations.filter(
    (o) => (o.kind === "field" || o.kind === "history") && matches(o, step),
  );
  if (c.obligationId) return candidates.find((o) => o.id === c.obligationId);
  if (c.prepare)
    return (
      candidates.find(
        (o) => o.kind === "history" && hash(o.history) === hash(c.prepare),
      ) ??
      candidates.find(
        (o) =>
          o.kind === "field" &&
          o.history &&
          hash(o.history) === hash(c.prepare),
      )
    );
  return candidates.find((o) => o.kind === "field");
}
