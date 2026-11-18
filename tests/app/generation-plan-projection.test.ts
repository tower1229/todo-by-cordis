import test from "node:test";
import assert from "node:assert/strict";
import {
  changeDefinition,
  generationPlanProjection,
} from "../../src/evolution/specification.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

test("generationPlanProjection 剥离机械验收表，changeDefinition 仍完整", () => {
  const plan = {
    requirements: [
      {
        id: "r1",
        description: "完成前填写复盘",
        sourceRevision: "run:1",
        sourceQuote: "完成前填写复盘",
        type: "behavior",
        checks: [{ checker: "browser/1", caseId: "case-1" }],
        obligations: [
          {
            id: "obl-1",
            kind: "field",
            member: "default",
            field: "review",
            expected: { fields: { review: "x" } },
            examples: ["x"],
            scenarios: [],
          },
        ],
      },
    ],
    browserCases: [
      {
        id: "case-1",
        task: "new",
        steps: [{ kind: "field", member: "default", field: "review", value: "x" }],
      },
    ],
    cases: [{ id: "backend", when: "complete", then: "done" }],
    acceptanceChanges: [{ rule: "浏览器案例 case-1", before: "{}", after: "{}", reason: "r" }],
    affectedAcceptance: { browserCaseIds: ["case-1"] },
    memberCases: [{ member: "default", name: "ok", expected: { kind: "commit", state: "done" } }],
    workflowRules: [{ key: "review", label: "复盘", required: true }],
    changes: [{ path: "src/x.ts" }],
    writableScope: { paths: ["src/"] },
  } as unknown as InvestigatedPlan;

  const frozen = changeDefinition(plan);
  assert.ok(frozen.browserCases?.length);
  assert.ok(frozen.requirements?.[0].obligations?.length);
  assert.ok(frozen.requirements?.[0].checks?.length);

  const projected = generationPlanProjection(plan);
  assert.equal(projected.browserCases, undefined);
  assert.equal(projected.cases, undefined);
  assert.equal(projected.acceptanceChanges, undefined);
  assert.equal(projected.affectedAcceptance, undefined);
  assert.equal(projected.requirements?.[0].obligations, undefined);
  assert.equal(projected.requirements?.[0].checks, undefined);
  assert.equal(projected.requirements?.[0].sourceQuote, "完成前填写复盘");
  assert.deepEqual(projected.memberCases, plan.memberCases);
  assert.deepEqual(projected.workflowRules, plan.workflowRules);
  assert.deepEqual(projected.changes, plan.changes);
  assert.deepEqual(projected.writableScope, plan.writableScope);

  // Frozen authority must remain intact after projection.
  assert.ok(changeDefinition(plan).browserCases?.length);
  assert.ok(changeDefinition(plan).requirements?.[0].obligations?.length);
});
