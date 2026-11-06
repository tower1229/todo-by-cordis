import test from "node:test";
import assert from "node:assert/strict";
import {
  browserCaseStem,
  obligationCases,
} from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import {
  browserCaseAssertionHash,
  browserCaseQuotaKey,
} from "../../src/evolution/browser-case-content.js";
import { inheritBrowserCases } from "../../src/evolution/references.js";
import { PlanStructureBlocked } from "../../src/evolution/historical-preparation.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";

const historyPrep = {
  baseVersion: "a".repeat(64),
  actions: [
    {
      kind: "action" as const,
      member: "tags",
      action: "setTags",
      input: { tags: "Hello" },
    },
  ],
  expected: { state: "open", fields: { tags: "Hello" } },
  sourceHash: "b".repeat(64),
};

test("field 与 history 的 historical 案例共用 stem，不因 kind 另起 ID", () => {
  const field: AcceptanceObligation = {
    version: 1,
    id: "field-tags",
    kind: "field",
    member: "tags",
    contribution: "tags-detail",
    field: "tags",
    initialOrigin: "host",
    initial: { kind: "visible", value: "（空）" },
    history: historyPrep,
    scenarios: [
      {
        id: "save",
        steps: [
          {
            kind: "action",
            member: "tags",
            action: "setTags",
            input: { tags: "Hello" },
          },
        ],
        value: "Hello",
      },
    ],
  };
  const history: AcceptanceObligation = {
    version: 1,
    id: "history-tags",
    kind: "history",
    member: "tags",
    contribution: "tags-detail",
    field: "tags",
    history: historyPrep,
  };
  assert.equal(browserCaseStem(field), browserCaseStem(history));
  const fromField = obligationCases(field).filter((c) =>
    c.id.includes("historical-"),
  );
  const fromHistory = obligationCases(history);
  assert.equal(fromHistory.length, 1);
  assert.equal(fromField.length, 1);
  assert.equal(fromField[0].id, fromHistory[0].id);
  assert.equal(
    browserCaseAssertionHash(fromField[0]),
    browserCaseAssertionHash(fromHistory[0]),
  );
});

test("多个 preserve-ui 义务共用 ui-identity-{task}，当前快照覆盖旧义务 ID", () => {
  const snapshot = (id: string, extra: boolean): AcceptanceObligation => ({
    version: 1,
    id,
    kind: "ui-identity",
    contributions: [
      {
        member: "tags",
        contribution: "tags-detail",
        fields: ["tags"],
        actions: ["setTags"],
      },
      ...(extra
        ? [
            {
              member: "counter",
              contribution: "count-detail",
              fields: ["count"],
              actions: ["increment"],
            },
          ]
        : []),
    ],
  });
  const first = obligationCases(snapshot("obligation-ui-a", false));
  const second = obligationCases(snapshot("obligation-ui-b", true));
  assert.deepEqual(
    first.map((c) => c.id),
    ["ui-identity-existing", "ui-identity-new"],
  );
  assert.deepEqual(
    second.map((c) => c.id),
    first.map((c) => c.id),
  );
  assert.equal(browserCaseQuotaKey(first[0]), "ui-identity:existing");
  const inherited = inheritBrowserCases(
    { requirements: [], browserCases: second },
    { requirements: [], browserCases: first },
    undefined,
  );
  assert.deepEqual(inherited.blockers, []);
  assert.equal(inherited.browserCases.length, 2);
  assert.ok(
    inherited.browserCases.every((c) => c.id.startsWith("ui-identity-")),
  );
});

test("多个 action-visible 同动作同可见性共用 assertion stem，当前 setup 覆盖", () => {
  const visible = (
    id: string,
    withReview: boolean,
  ): AcceptanceObligation => ({
    version: 1,
    id,
    kind: "assertion",
    steps: withReview
      ? [
          {
            kind: "action",
            member: "workflow",
            action: "complete",
            input: { review: "验" },
          },
        ]
      : [{ kind: "action", member: "workflow", action: "complete" }],
    expected: {
      kind: "action-visible",
      member: "counter",
      contribution: "count-detail",
      action: "increment",
      visible: false,
    },
  });
  const before = obligationCases(visible("obligation-vis-old", false));
  const after = obligationCases(visible("obligation-vis-new", true));
  assert.equal(before[0].id, after[0].id);
  assert.notEqual(
    browserCaseAssertionHash(before[0]),
    browserCaseAssertionHash(after[0]),
  );
  const inherited = inheritBrowserCases(
    { requirements: [], browserCases: after },
    { requirements: [], browserCases: before },
    undefined,
  );
  assert.deepEqual(inherited.blockers, []);
  assert.equal(inherited.browserCases.length, 2);
  assert.ok(
    inherited.browserCases.some((c) =>
      c.steps.some(
        (s) => s.kind === "action" && s.action === "complete" && s.input,
      ),
    ),
  );
});

test("parseBrowserCases 超限仍是 PlanStructureBlocked，不抬上限", () => {
  const cases = Array.from({ length: 32 }, (_, i) => ({
    id: `case-${i}`,
    task: "new" as const,
    steps: [{ kind: "refresh" as const }],
  }));
  assert.throws(() => parseBrowserCases(cases), (error: unknown) => {
    assert.ok(error instanceof PlanStructureBlocked);
    assert.match(String(error.message), /浏览器验收案例超出上限：32 条，最多 30 条/);
    return true;
  });
});
