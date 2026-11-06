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
import { compileReferences, inheritBrowserCases } from "../../src/evolution/references.js";
import { PlanStructureBlocked } from "../../src/evolution/historical-preparation.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { panelMemberCases } from "./member-case-fixtures.js";

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

test("browser-acceptance 历史夹具收掉 field/history 分叉后仍有两条互异准备", () => {
  const updatedCases = panelMemberCases.map((c) => ({
    ...c,
    expected:
      c.expected.kind === "commit"
        ? { ...c.expected, fields: { noteMark: "reviewed" } }
        : c.expected,
  }));
  const sources = [
    { id: "history:1", text: "原标记不自动替换，新动作写 reviewed，详情刷新重启保留" },
  ];
  const compiled = compileReferences(
    {
      workflowRules: [],
      memberCases: updatedCases,
      browserCases: [],
      requirements: [
        {
          id: "identity",
          source: 1,
          sourceQuote: sources[0].text,
          description: "界面身份沿用基线",
          type: "interface",
          checks: [],
          obligations: [{ kind: "preserve-ui" }],
        },
        {
          id: "history",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "interface",
          checks: [],
          obligations: [
            {
              kind: "field",
              field: "noteMark",
              initial: { kind: "visible", value: "（空）" },
              scenarios: [
                {
                  steps: [{ kind: "action", action: "markNote", input: {} }],
                  value: "reviewed",
                },
              ],
            },
            { kind: "history", field: "noteMark" },
          ],
        },
      ],
    },
    sources,
    [],
    { id: "default", actions: [{ id: "complete" }, { id: "reopen" }] },
    {
      memberCases: panelMemberCases,
      baseVersion: "a".repeat(64),
      uiContributions: [
        {
          id: "note-panel",
          providerId: "panel",
          fields: [{ key: "noteMark" }],
          actions: [{ commandId: "markNote" }],
        },
      ],
    },
  );
  const cases = parseBrowserCases(compiled.browserCases);
  const prepared = cases.filter((c) => c.prepare);
  const historical = cases.filter((c) => c.id.includes("-historical-"));
  const afterExisting = prepared.find(
    (c) => c.task === "existing" && c.id.includes("-after-"),
  );
  const field = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "field");
  const history = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "history");
  assert.ok(field && history);
  assert.equal(
    obligationCases(field).find((c) => c.id.includes("-historical-"))?.id,
    obligationCases(history)[0]?.id,
  );
  assert.equal(prepared.length, 2);
  assert.equal(historical.length, 1);
  assert.ok(afterExisting);
  assert.notEqual(
    browserCaseAssertionHash(historical[0]),
    browserCaseAssertionHash(afterExisting),
  );
  assert.ok(cases.length <= 30);
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
