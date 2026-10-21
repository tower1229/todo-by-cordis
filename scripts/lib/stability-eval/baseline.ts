import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hash } from "../../../src/release/storage.js";
import type { Version } from "../../../src/release/types.js";
import type { Workspace } from "../../../src/server/workspace.js";
import type { MemberAcceptanceCase } from "../../../src/shared/acceptance-cases.js";
import { verifyViaIsolatedWorkspace, type WorkspaceCaseEvidence } from "../../../src/server/workspace-acceptance.js";
import { activateDual } from "../../../tests/app/dual-composition-fixture.js";

const baselineCases: MemberAcceptanceCase[] = [
  { name: "标签去空格", member: "tags", state: "open", fields: {}, action: "setTags",
    input: { tags: "  Hello " }, expected: { kind: "commit", state: "open", fields: { tags: "Hello" } } },
  { name: "空白标签拒绝", member: "tags", state: "open", fields: {}, action: "setTags",
    input: { tags: "   " }, expected: { kind: "reject" } },
  { name: "设置截止日期成功", member: "due", state: "open", fields: {}, action: "setDue",
    input: { dueAt: "2030-01-01T12:00:00Z" }, expected: { kind: "commit", state: "open", fields: { dueAt: "2030-01-01T12:00:00Z" } } },
  { name: "已完成不可设截止", member: "due", state: "done", fields: {}, action: "setDue",
    input: { dueAt: "2030-01-01T12:00:00Z" }, expected: { kind: "reject" } },
];

function input(version: Version) {
  const { id: _id, entry: _entry, createdAt: _createdAt, ...value } = version;
  return value;
}

/** Establish real, source-bound fixture evidence before the model sees the baseline. */
export async function activateStabilityBaseline(workspace: Workspace) {
  const { composition, tags } = await activateDual(workspace);
  const source = await readFile(new URL("../../../tests/fixtures/stability-tags-baseline.mjs", import.meta.url), "utf8");
  const memberCases = structuredClone(baselineCases);
  const tagsInput = { ...input(tags), source, code: source };
  const draftTags = workspace.release.record({ ...tagsInput, evidence: { passed: false, origin: "stability-baseline-draft" } });
  const members = composition.members!.map((m) => m.pluginId === "tags" ? { ...m, versionId: draftTags.id } : m);
  const draft = workspace.release.record({ ...input(composition), members,
    evidence: { passed: false, origin: "stability-baseline-draft", memberCases } });
  const workspaceCases: WorkspaceCaseEvidence[] = [];
  const checks = await verifyViaIsolatedWorkspace(workspace, draft, memberCases, new AbortController().signal,
    (receipt) => workspaceCases.push(receipt), [{ member: "tags", fields: ["tags"] }, { member: "due", fields: ["dueAt"] }]);
  const validation = { checker: "workspace/1", checkedCompositionVersionId: draft.id,
    definitionHash: hash(memberCases), memberArtifactHash: hash({ source, code: source }),
    workspaceCases, checks };
  const acceptedTags = workspace.release.record({ ...tagsInput, evidence: { passed: true,
    origin: "stability-baseline-verified", memberCases: memberCases.filter((c) => c.member === "tags"), validation } });
  const accepted = workspace.release.record({ ...input(composition),
    members: members.map((m) => m.pluginId === "tags" ? { ...m, versionId: acceptedTags.id } : m),
    evidence: { passed: true, origin: "stability-baseline-verified", memberCases, validation } });
  const finalCases: WorkspaceCaseEvidence[] = [];
  const finalChecks = await verifyViaIsolatedWorkspace(workspace, accepted, memberCases, new AbortController().signal,
    (receipt) => finalCases.push(receipt), [{ member: "tags", fields: ["tags"] }, { member: "due", fields: ["dueAt"] }]);
  await workspace.activate({ versionId: accepted.id, compositionRevision: workspace.composition().revision,
    operationId: randomUUID() }, () => undefined);
  return { version: accepted, evidence: { checker: "workspace/1", compositionVersionId: accepted.id,
    definitionHash: hash(memberCases), memberCases, checks: finalChecks, workspaceCases: finalCases } };
}
