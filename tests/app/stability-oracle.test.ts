import test from "node:test";
import assert from "node:assert/strict";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import {
  checkIndependentPlan,
  checkIndependentBrowser,
} from "../../scripts/lib/stability-eval/oracle.js";
import type { BrowserEvidence } from "../../src/shared/browser-cases.js";

test("模型自报通过不能替代原文要求：遗漏必填或替换长度上限被独立判定拒绝", () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(
    (s) => s.id === "rule-revision-reflection",
  )!;
  for (const workflowRules of [
    [],
    [
      {
        key: "reflection",
        label: "复盘",
        required: false,
        minLength: 1,
        maxLength: 5000,
      },
    ],
    [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
    ],
  ]) {
    const checks = checkIndependentPlan(scenario, {
      workflowRules,
      requirements: [],
    });
    assert(checks.some((c) => c.status === "failed"));
  }
});

test("基础页面成功或重复同一视口的通过结果不能冒充独立业务覆盖", () => {
  const evidence: BrowserEvidence = {
    checker: "browser/1",
    checkerHash: "fixture",
    candidateVersion: "candidate",
    baseVersion: "base",
    candidateProgramHash: "program",
    definitionHash: "definition",
    frontendHash: "frontend",
    fixtureHash: "fixture",
    directory: "fixture",
    results: [],
  };
  const cases = [{ id: "business", task: "new" as const, steps: [] }];
  for (const results of [
    [
      {
        caseId: "host:basic",
        requirementIds: [],
        viewport: { width: 390, height: 844 },
        status: "passed" as const,
      },
    ],
    [1, 2].map(() => ({
      caseId: "business",
      requirementIds: [],
      viewport: { width: 390, height: 844 },
      status: "passed" as const,
    })),
  ])
    assert.equal(
      checkIndependentBrowser(cases, { ...evidence, results }).status,
      "failed",
    );
  const results = [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ].map((viewport) => ({
    caseId: "business",
    requirementIds: [],
    viewport,
    status: "passed" as const,
  }));
  assert.equal(
    checkIndependentBrowser(cases, { ...evidence, results }).status,
    "passed",
  );
});
