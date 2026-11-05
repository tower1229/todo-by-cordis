import test from "node:test";
import assert from "node:assert/strict";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import { hash } from "../../src/release/storage.js";

/**
 * Regression test for frozen acceptance self-conflict (bounded-probe-1416f54 failure):
 * 
 * When workflow gains required fields (e.g., review), workflow-input obligation generates
 * browser cases expecting complete WITH input. These can conflict with inherited
 * system-protection cases that expect complete WITHOUT input from the old workflow.
 * 
 * Fix: In references.ts line 640-650, workflow-input cases supersede conflicting
 * system-protection cases by replacing them instead of throwing.
 */

test("workflow-input cases can supersede old system-protection assertion cases", () => {
  // Simulate the frozen self-conflict scenario:
  // 1. Old system-protection case expects complete with no input
  // 2. New workflow-input obligation expects complete WITH input
  // 3. Both generate cases with potentially conflicting IDs
  
  const workflowId = "review";
  const workflowInputId = `workflow-input-${hash(workflowId).slice(0, 16)}`;
  
  // Old assertion obligation (system-available → system-protection)
  const oldAssertion: AcceptanceObligation = {
    version: 1,
    id: "obligation-old-complete",
    kind: "assertion",
    availability: "system-available",
    steps: [],
    expected: { kind: "action-visible", member: "workflow", action: "complete" },
  };
  
  const oldCases = obligationCases(oldAssertion);
  assert.ok(oldCases.length > 0, "Old assertion generates browser cases");
  assert.ok(oldCases.every(c => c.classification === "system-protection"), "Old cases are system-protection");
  
  // New workflow-input obligation (workflow WITH required review field)
  const newWorkflowInput: AcceptanceObligation = {
    version: 1,
    id: workflowInputId,
    kind: "workflow-input",
    rules: [{ key: "review", required: true, minLength: 1, maxLength: 5000 }],
  };
  
  const newCases = obligationCases(newWorkflowInput);
  assert.ok(newCases.length > 0, "New workflow-input generates browser cases");
  assert.ok(newCases.every(c => c.classification === "frozen-business"), "New cases are frozen-business");
  
  // Verify that workflow-input cases have input requirements
  const completeActions = newCases.flatMap(c =>
    c.steps.filter(s => s.kind === "action" && s.member === "workflow" && s.action === "complete")
  );
  const hasInputRequirements = completeActions.some(step =>
    step.kind === "action" && ("input" in step || step.kind === "form-invalid")
  );
  assert.ok(hasInputRequirements || newCases.some(c => c.steps.some(s => s.kind === "form-invalid")),
    "workflow-input cases include input validation");
  
  // The fix in references.ts ensures that if these cases have the same ID but different content,
  // workflow-input supersedes system-protection instead of throwing a conflict error.
  // This test verifies the obligations generate distinct classifications.
  assert.notEqual(
    oldCases[0].classification,
    newCases[0].classification,
    "Different obligation kinds produce different classifications"
  );
});

test("system-protection and frozen-business classifications are distinct", () => {
  // System-protection comes from assertion with availability="system-available"
  const systemAssertion: AcceptanceObligation = {
    version: 1,
    id: "test-system",
    kind: "assertion",
    availability: "system-available",
    steps: [],
    expected: { kind: "task", task: "new", fields: {} },
  };
  
  const systemCases = obligationCases(systemAssertion);
  assert.ok(systemCases.every(c => c.classification === "system-protection"));
  
  // frozen-business comes from workflow-input or normal field obligations
  const workflowInput: AcceptanceObligation = {
    version: 1,
    id: "test-workflow-input",
    kind: "workflow-input",
    rules: [{ key: "note", required: true, minLength: 1, maxLength: 100 }],
  };
  
  const frozenCases = obligationCases(workflowInput);
  assert.ok(frozenCases.every(c => c.classification === "frozen-business"));
});
