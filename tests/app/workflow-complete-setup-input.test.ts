import test from "node:test";
import assert from "node:assert/strict";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { WorkflowRule } from "../../src/shared/assistant.js";
import type { BrowserStep } from "../../src/shared/browser-cases.js";
import {
  bindWorkflowCompleteInputs,
  workflowValidCompleteInput,
} from "../../src/shared/workflow-browser.js";
import { compileReferences } from "../../src/evolution/references.js";

/**
 * Root-cause regression from tip 3d069ed paid stop:
 * assertion used bare workflow.complete as setup to reach done, then asserted
 * counter.increment visible:false. After workflow gained required review input,
 * host still emitted bare complete → browser never arrived → assertion failed.
 */

const reviewRules: WorkflowRule[] = [
  {
    key: "review",
    label: "review",
    required: true,
    minLength: 1,
    maxLength: 5000,
  },
];

const sources = [{ id: "run:1", text: "完成后隐藏计数增加" }];
const memberCases = [
  {
    member: "counter",
    action: "increment",
    name: "bump",
    fields: {},
    input: {},
    expected: { kind: "commit" as const, fields: {} },
  },
];
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
  fields: [{ key: "review" }],
};
const uiContributions = [
  {
    id: "count-detail",
    providerId: "counter",
    fields: [] as { key: string }[],
    actions: [{ commandId: "increment" }],
  },
];

function completeInputsFrom(
  steps: BrowserStep[],
): Record<string, string> | undefined {
  const step = steps.find(
    (s) =>
      s.kind === "action" &&
      s.member === "workflow" &&
      s.action === "complete",
  );
  return step?.kind === "action" ? step.input : undefined;
}

test("bare complete-as-setup gains host valid input when workflow-input exists", () => {
  const steps: BrowserStep[] = [
    { kind: "action", member: "workflow", action: "complete" },
  ];
  const bound = bindWorkflowCompleteInputs(steps, reviewRules);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].kind, "action");
  if (bound[0].kind !== "action") return;
  assert.deepEqual(bound[0].input, workflowValidCompleteInput(reviewRules));
  assert.equal(bound[0].input?.review, "验");
});

test("3d069ed-shaped assertion obligationCases include complete input after bind", () => {
  const bare: AcceptanceObligation = {
    version: 1,
    id: "assertion-d57-shaped",
    kind: "assertion",
    availability: { origin: "host", state: "done" },
    steps: [{ kind: "action", member: "workflow", action: "complete" }],
    expected: {
      kind: "action-visible",
      member: "counter",
      action: "increment",
      visible: false,
    },
  };
  const rewritten: AcceptanceObligation = {
    ...bare,
    steps: bindWorkflowCompleteInputs(bare.steps, reviewRules),
  };
  const cases = obligationCases(rewritten);
  assert.ok(cases.length >= 1);
  for (const c of cases) {
    const completes = c.steps.filter(
      (s) =>
        s.kind === "action" &&
        s.member === "workflow" &&
        s.action === "complete",
    );
    assert.ok(completes.length >= 1);
    for (const step of completes) {
      if (step.kind !== "action") continue;
      assert.ok(step.input, "complete-as-setup must carry host input");
      assert.equal(step.input.review, "验");
    }
    const expected = c.steps.at(-1);
    assert.equal(expected?.kind, "action-visible");
    if (expected?.kind === "action-visible") {
      assert.equal(expected.member, "counter");
      assert.equal(expected.action, "increment");
      assert.equal(expected.visible, false);
    }
  }
});

test("intentional empty or short complete input is not rewritten", () => {
  const intentional: BrowserStep[] = [
    {
      kind: "action",
      member: "workflow",
      action: "complete",
      input: { review: "" },
    },
    { kind: "error", text: "" },
    {
      kind: "action",
      member: "workflow",
      action: "complete",
      input: { review: " " },
    },
    { kind: "error", text: "" },
  ];
  const bound = bindWorkflowCompleteInputs(intentional, reviewRules);
  assert.deepEqual(bound, intentional);
});

test("form-invalid steps are untouched", () => {
  const steps: BrowserStep[] = [
    {
      kind: "form-invalid",
      member: "workflow",
      action: "complete",
      field: "review",
      input: { review: "" },
    },
    { kind: "action", member: "workflow", action: "complete" },
  ];
  const bound = bindWorkflowCompleteInputs(steps, reviewRules);
  assert.equal(bound[0].kind, "form-invalid");
  assert.deepEqual(bound[0], steps[0]);
  assert.equal(bound[1].kind, "action");
  if (bound[1].kind === "action")
    assert.equal(bound[1].input?.review, "验");
});

test("no rules leaves bare complete unchanged", () => {
  const steps: BrowserStep[] = [
    { kind: "action", member: "workflow", action: "complete" },
  ];
  assert.deepEqual(bindWorkflowCompleteInputs(steps, []), steps);
});

test("compileReferences injects complete input on fresh assertion (bindSteps path)", () => {
  const compiled = compileReferences(
    {
      workflowRules: reviewRules,
      memberCases,
      browserCases: [],
      requirements: [
        {
          id: "vis",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "behavior",
          checks: [],
          obligations: [
            {
              kind: "assertion",
              steps: [{ kind: "action", action: "complete" }],
              expected: {
                kind: "action-visible",
                action: "increment",
                visible: false,
              },
            },
          ],
        },
      ],
    },
    sources,
    [],
    workflow,
    { memberCases, browserCases: [], requirements: [], uiContributions },
  );
  const assertion = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "assertion");
  assert.ok(assertion && assertion.kind === "assertion");
  assert.deepEqual(
    completeInputsFrom(assertion.steps),
    workflowValidCompleteInput(reviewRules),
  );
  const emitted = compiled.browserCases.filter(
    (c) => c.obligationId === assertion.id,
  );
  assert.ok(emitted.length >= 1);
  for (const c of emitted)
    assert.deepEqual(
      completeInputsFrom(c.steps),
      workflowValidCompleteInput(reviewRules),
    );
});

test("compileReferences rewrites late-inherited bare assertion (obligation loop)", () => {
  const bare: AcceptanceObligation = {
    version: 1,
    id: "assertion-bare-inherited",
    kind: "assertion",
    steps: [{ kind: "action", member: "workflow", action: "complete" }],
    expected: {
      kind: "action-visible",
      member: "counter",
      contribution: "count-detail",
      action: "increment",
      visible: false,
    },
  };
  assert.equal(completeInputsFrom(bare.steps), undefined);
  const compiled = compileReferences(
    {
      workflowRules: reviewRules,
      memberCases,
      browserCases: [],
      requirements: [
        {
          id: "other",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "behavior",
          checks: [],
          obligations: [{ kind: "preserve-ui" }],
        },
      ],
    },
    sources,
    [],
    workflow,
    {
      requirementGate: { sources },
      memberCases,
      browserCases: [],
      requirements: [
        {
          id: "vis",
          description: sources[0].text,
          sourceRevision: "run:1",
          sourceQuote: sources[0].text,
          type: "behavior",
          checks: [],
          obligations: [bare],
        },
      ],
      uiContributions,
      baseVersion: "a".repeat(64),
    },
  );
  assert.ok(compiled.requirements.some((r) => r.id === "vis"));
  const assertion = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "assertion" && o.id === bare.id);
  assert.ok(assertion && assertion.kind === "assertion");
  assert.deepEqual(
    completeInputsFrom(assertion.steps),
    workflowValidCompleteInput(reviewRules),
  );
  const emitted = compiled.browserCases.filter(
    (c) => c.obligationId === bare.id,
  );
  assert.ok(emitted.length >= 1);
  for (const c of emitted)
    assert.deepEqual(
      completeInputsFrom(c.steps),
      workflowValidCompleteInput(reviewRules),
    );
});

test("compileReferences rewrites late-inherited bare feedback scenarios", () => {
  const feedback: AcceptanceObligation = {
    version: 1,
    id: "feedback-bare-inherited",
    kind: "feedback",
    action: { kind: "action", member: "workflow", action: "complete" },
    text: "",
    resolution: "required",
    scenarios: [
      {
        steps: [{ kind: "action", member: "workflow", action: "complete" }],
      },
    ],
    unavailable: [],
  };
  const compiled = compileReferences(
    {
      workflowRules: reviewRules,
      memberCases: [],
      browserCases: [],
      requirements: [
        {
          id: "other",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "behavior",
          checks: [],
          obligations: [{ kind: "preserve-ui" }],
        },
      ],
    },
    sources,
    [],
    workflow,
    {
      requirementGate: { sources },
      memberCases: [],
      browserCases: [],
      requirements: [
        {
          id: "fb",
          description: sources[0].text,
          sourceRevision: "run:1",
          sourceQuote: sources[0].text,
          type: "behavior",
          checks: [],
          obligations: [feedback],
        },
      ],
      baseVersion: "a".repeat(64),
    },
  );
  const rewritten = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "feedback" && o.id === feedback.id);
  assert.ok(rewritten && rewritten.kind === "feedback");
  assert.deepEqual(
    completeInputsFrom(rewritten.scenarios[0].steps),
    workflowValidCompleteInput(reviewRules),
  );
});

test("compileReferences bindSteps injects bare complete on draft browserCases", () => {
  const compiled = compileReferences(
    {
      workflowRules: reviewRules,
      memberCases,
      browserCases: [
        {
          id: "manual-bare-complete",
          task: "new",
          steps: [
            { kind: "action", action: "complete" },
            {
              kind: "action-visible",
              action: "increment",
              visible: false,
            },
          ],
        },
      ],
      requirements: [
        {
          id: "vis",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "behavior",
          checks: [{ kind: "browser", index: 1 }],
          obligations: [{ kind: "preserve-ui" }],
        },
      ],
    },
    sources,
    [],
    workflow,
    { memberCases, browserCases: [], requirements: [], uiContributions },
  );
  const manual = compiled.browserCases.find(
    (c) =>
      c.steps.some(
        (s) =>
          s.kind === "action" &&
          s.member === "workflow" &&
          s.action === "complete",
      ) &&
      c.steps.some(
        (s) =>
          s.kind === "action-visible" &&
          s.member === "counter" &&
          s.action === "increment" &&
          s.visible === false,
      ),
  );
  assert.ok(manual, "draft browser case must remain after host id rewrite");
  assert.deepEqual(
    completeInputsFrom(manual.steps),
    workflowValidCompleteInput(reviewRules),
  );
});
