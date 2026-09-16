import test from "node:test";
import assert from "node:assert/strict";
import { BusinessAssertionError } from "../../src/server/business-verification.js";
import {
  assertWorkspaceCaseCoverage,
  requireAffectedAcceptanceForMemberChange,
  type WorkspaceAcceptanceCase,
} from "../../src/server/workspace-acceptance.js";

test("requireAffectedAcceptanceForMemberChange rejects incomplete coverage on member change", () => {
  assert.throws(
    () =>
      requireAffectedAcceptanceForMemberChange(
        {
          targets: [],
          coverageSummary: [],
          complete: false,
          gaps: ["新增辅助成员 panel 缺少冻结业务案例覆盖"],
        },
        true,
      ),
    (error: unknown) =>
      error instanceof BusinessAssertionError &&
      /验收缺失/.test(error.message) &&
      /panel/.test(error.message),
  );
});

test("requireAffectedAcceptanceForMemberChange skips when no member change or coverage complete", () => {
  assert.doesNotThrow(() =>
    requireAffectedAcceptanceForMemberChange(undefined, true),
  );
  assert.doesNotThrow(() =>
    requireAffectedAcceptanceForMemberChange(
      { targets: [], coverageSummary: [], complete: false, gaps: ["x"] },
      false,
    ),
  );
  assert.doesNotThrow(() =>
    requireAffectedAcceptanceForMemberChange(
      { targets: [], coverageSummary: [], complete: true, gaps: [] },
      true,
    ),
  );
});

test("assertWorkspaceCaseCoverage requires commit and reject pairs per authorized action", () => {
  const affected = {
    targets: [
      { pluginId: "tags", kind: "upgrade" as const, actions: ["setTags"], caseNames: [] },
    ],
    coverageSummary: [],
    complete: true,
    gaps: [],
  };
  const onlyCommit: WorkspaceAcceptanceCase[] = [
    {
      name: "workspace:member:tags:only-commit",
      member: "tags",
      state: "open",
      fields: {},
      action: "setTags",
      input: { tags: "a" },
      expected: { kind: "commit", state: "open", fields: { tags: "a" } },
    },
  ];
  assert.throws(
    () => assertWorkspaceCaseCoverage(affected, onlyCommit),
    (error: unknown) =>
      error instanceof BusinessAssertionError && /验收缺失/.test(error.message),
  );
  const paired: WorkspaceAcceptanceCase[] = [
    ...onlyCommit,
    {
      name: "workspace:member:tags:reject",
      member: "tags",
      state: "open",
      fields: {},
      action: "setTags",
      input: { tags: "   " },
      expected: { kind: "reject" },
    },
  ];
  assert.doesNotThrow(() => assertWorkspaceCaseCoverage(affected, paired));
});
