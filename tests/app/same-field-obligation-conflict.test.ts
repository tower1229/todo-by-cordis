import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences } from "../../src/evolution/references.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { Requirement } from "../../src/shared/assistant.js";

/**
 * Regression test for bounded-probe-dad4a6f phase-2 failure:
 * "同一字段验收义务发生冲突，初始状态或相同操作不能要求不同结果"
 * 
 * Root cause: When adding a new plugin (counter) while preserving an existing plugin (tags),
 * deriveFieldObligations creates projections from currentDefinitions that conflict with
 * canPreserve fields. Both have the same obligation.id but different content, causing
 * browser case ID collision in line 629-639.
 */
test("添加新插件时，旧插件派生字段的投影不与保留字段冲突", () => {
  const sources = [
    { id: "accepted:1", text: "保存标签" },
    { id: "request:2", text: "新增计数，保留标签" },
  ];
  const workflow = { id: "default", fields: [], actions: [{ id: "complete" }] };

  // Phase-0/1: tags plugin was applied
  const tagsCases: MemberAcceptanceCase[] = [
    {
      member: "tags",
      name: "setTag",
      state: "open",
      fields: {},
      action: "setTag",
      input: { tag: "Alpha" },
      expected: { kind: "commit", state: "open", fields: { tag: "Alpha" } },
    },
  ];

  const tagsField: Extract<AcceptanceObligation, { kind: "field" }> = {
    version: 1,
    id: "field-tags-abc123",
    kind: "field",
    member: "tags",
    field: "tag",
    initialOrigin: "host",
    initial: { kind: "visible", value: "（空）" },
    derivation: { checker: "workspace/1" },
    scenarios: [
      {
        id: "set",
        steps: [{ kind: "action", member: "tags", action: "setTag", input: { tag: "Alpha" } }],
        value: "Alpha",
      },
    ],
  };

  const tagsReq: Requirement = {
    id: "tags-requirement",
    description: sources[0].text,
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    type: "behavior",
    checks: [{ checker: "workspace/1", caseId: "member:tags:setTag" }],
    obligations: [tagsField],
  };

  const inherited = {
    memberCases: tagsCases,
    requirements: [tagsReq],
    browserCases: [], // Simplified for test
    fieldIdentities: [{ member: "tags", field: "tag", label: "标签" }],
    uiContributions: [
      {
        id: "tags-ui",
        providerId: "tags",
        fields: [{ key: "tag" }],
        actions: [{ commandId: "setTag" }],
      },
    ],
  };

  // Phase-2: Add counter plugin while preserving tags
  const counterCases: MemberAcceptanceCase[] = [
    {
      member: "counter",
      name: "increment",
      state: "open",
      fields: {},
      action: "increment",
      input: {},
      expected: { kind: "commit", state: "open", fields: { count: "1" } },
    },
  ];

  const draft = {
    workflowRules: [],
    memberCases: [...tagsCases, ...counterCases],
    browserCases: [],
    requirements: [
      // New counter requirement (will trigger replacement with canPreserve)
      {
        id: "counter-requirement",
        source: 2,
        sourceQuote: sources[1].text,
        description: sources[1].text,
        type: "behavior",
        checks: [
          { kind: "member", index: 2 }, // counter (new)
        ],
        obligations: [{ kind: "backend" }],
      },
      // Separate requirement that explicitly declares tags field with different initialOrigin
      // This will be in currentDefinitions and cause deriveFieldObligations to create a projection
      {
        id: "tags-explicit-requirement",
        source: 2,
        sourceQuote: "保留标签初始显示",
        description: "保留标签初始显示",
        type: "interface",
        checks: [
          { kind: "member", index: 1 }, // tags
        ],
        obligations: [
          {
            kind: "backend",
          },
          {
            kind: "field",
            field: "tag",
            initial: { kind: "visible", value: "空白" }, // Different from canPreserve (which has "（空）")
            scenarios: [
              {
                steps: [{ kind: "action", action: "setTag", input: { tag: "Alpha" } }],
                value: "Alpha",
              },
            ],
          },
        ],
      },
    ],
  };

  // This should not throw "同一字段验收义务发生冲突"
  const result = compileReferences(draft, sources, [], workflow, inherited);

  // Verify tags field is preserved
  const tagsFields = result.requirements
    .flatMap((r) => r.obligations ?? [])
    .filter((o): o is Extract<AcceptanceObligation, { kind: "field" }> => o.kind === "field" && o.member === "tags");

  assert.ok(tagsFields.length > 0, "tags 字段应该被保留");

  // Verify no duplicate obligation IDs with different content
  const obligations = result.requirements.flatMap((r) => r.obligations ?? []);
  const idMap = new Map<string, AcceptanceObligation>();
  for (const o of obligations) {
    const existing = idMap.get(o.id);
    if (existing) {
      // Same ID must have same content
      assert.deepEqual(
        o,
        existing,
        `Obligation ID ${o.id} 不应该有不同的内容：\nExisting: ${JSON.stringify(existing, null, 2)}\nNew: ${JSON.stringify(o, null, 2)}`,
      );
    } else {
      idMap.set(o.id, o);
    }
  }
});
