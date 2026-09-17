// External Gemini calls require ACCEPT_REAL_MODEL=1 and GEMINI_API_KEY.
// Fresh synthetic workflow-only workspace; add tags then upgrade lowercase; no experience.
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { Gemini } from "../src/evolution/gemini.js";
import { activateWorkflowOnly } from "../tests/app/dual-composition-fixture.js";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../src/shared/assistant.js";
import {
  assertFormalFingerprintUnchanged,
  buildBreakpoint,
  buildShortenedTrialHeader,
  formalWorkspaceFingerprint,
  redactSensitive,
  requireRealModelAuthorization,
  summarizeCandidateResults,
  summarizeRunConfirmation,
} from "./lib/shortened-real-model.js";

if (existsSync(".env")) process.loadEnvFile(".env");
requireRealModelAuthorization();

const ISSUE = "https://github.com/tower1229/todo-by-cordis/issues/33";
const PARENT = "https://github.com/tower1229/todo-by-cordis/issues/30";
const REQUEST_ADD_TAGS =
  "请新增标签插件：保存标签时去掉首尾空格，空白标签必须拒绝。保留现有工作流与其他字段行为不变。";
const REQUEST_LOWERCASE_TAGS =
  "请继续升级刚新增的标签插件：保存时统一转为小写，仍要去掉首尾空格并拒绝空白标签。其他成员与任务行为保持不变。";

const SHORTENED_LIMITS = {
  calls: 12,
  candidates: 1,
  milliseconds: 600_000,
} as const;

const directory =
  process.env.ACCEPTANCE_PATH ??
  mkdtempSync(join(tmpdir(), "cordis-issue33-shortened-"));
console.log(directory);

const sourceFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(root, entry.name))
      : [join(root, entry.name)],
  );

const evidence: unknown[] = [
  buildShortenedTrialHeader({
    issue: ISSUE,
    parentIssue: PARENT,
    businessRequests: [REQUEST_ADD_TAGS, REQUEST_LOWERCASE_TAGS],
  }),
  {
    sourceManifest: Object.fromEntries(
      sourceFiles("src")
        .sort()
        .map((path) => [
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
    ),
  },
];

let currentPhase = "bootstrap";
const workspace = await Workspace.open(join(directory, "workspace.db"));
await activateWorkflowOnly(workspace);
const seedTask = (
  await workspace.command({
    type: "create",
    operationId: randomUUID(),
    compositionRevision: workspace.composition().revision,
    title: "缩短试跑保留任务",
  })
).task!;
let formalBefore = formalWorkspaceFingerprint({
  composition: workspace.composition(),
  tasks: workspace.query(),
});

const evolution = new Evolution(
  workspace.db,
  new Gemini(process.env.GEMINI_API_KEY!),
  new EvolutionDomain(workspace),
  SHORTENED_LIMITS,
);

const command = async (input: AssistantCommand) => {
  const receipt = await evolution.command(input);
  evidence.push({
    command: redactSensitive(input),
    receipt: redactSensitive(receipt),
  });
  return receipt;
};

function caseSummariesFromSnapshot(snapshot: AssistantSnapshot) {
  return (snapshot.candidates ?? []).map((candidate) => {
    if (!candidate.versionId) return { versionId: candidate.versionId };
    try {
      const evidenceBody = workspace.release.get(candidate.versionId)
        .evidence as {
        checks?: string[];
        memberCases?: { name?: string }[];
      };
      return {
        versionId: candidate.versionId,
        checks: evidenceBody.checks,
        memberCaseNames: evidenceBody.memberCases
          ?.map((c) => c.name)
          .filter((name): name is string => !!name),
      };
    } catch {
      return { versionId: candidate.versionId };
    }
  });
}

async function settled(): Promise<AssistantSnapshot> {
  let last = "";
  for (let i = 0; i < 660; i++) {
    const snapshot = await evolution.observe();
    const status = snapshot.run?.status ?? "missing";
    if (status !== last) {
      console.log(status);
      last = status;
    }
    if (!["planning", "executing", "applying"].includes(status)) {
      evidence.push({
        snapshotSummary: {
          run: summarizeRunConfirmation(snapshot),
          candidates: summarizeCandidateResults(
            snapshot,
            caseSummariesFromSnapshot(snapshot),
          ),
        },
      });
      return snapshot;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("acceptance timeout");
}

function assertFormalAt(label: string) {
  assertFormalFingerprintUnchanged(
    label,
    formalBefore,
    formalWorkspaceFingerprint({
      composition: workspace.composition(),
      tasks: workspace.query(),
    }),
  );
}

async function publishPhase(label: string) {
  currentPhase = label;
  let snapshot = await settled();
  assertFormalAt(`${label}-after-planning`);
  if (snapshot.run?.status === "awaiting-acceptance") {
    const run = snapshot.run;
    console.log(
      "confirming acceptance revision",
      JSON.stringify(run.acceptanceRevision?.changes),
    );
    await command({
      type: "confirm-acceptance",
      operationId: randomUUID(),
      runId: run.id,
      planId: run.plan.id,
      revisionId: run.acceptanceRevision!.id,
    });
    snapshot = await settled();
    assertFormalAt(`${label}-after-acceptance-confirm`);
  }
  const ready = snapshot.run;
  assert.equal(ready?.status, "ready", JSON.stringify(ready));
  if (ready?.status !== "ready") throw new Error("not ready");
  await command({
    type: "start",
    operationId: randomUUID(),
    runId: ready.id,
    planId: ready.plan.id,
  });
  snapshot = await settled();
  assert.equal(
    snapshot.run?.status,
    "awaiting-apply",
    JSON.stringify(snapshot.run),
  );
  assertFormalAt(`${label}-before-apply`);
  const candidate = snapshot.candidates!.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash, JSON.stringify(snapshot.candidates));
  await command({
    type: "apply",
    operationId: randomUUID(),
    runId: ready.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: workspace.composition().revision,
  });
  const applied = (await settled()).run!;
  assert.equal(applied.status, "succeeded", JSON.stringify(applied));
  evidence.push({
    phase: label,
    publishedVersionId: applied.versionId,
    composition: workspace.composition(),
  });
  return applied;
}

const action = async (
  actionId: string,
  input: Record<string, string> = {},
) =>
  workspace.command({
    type: "action",
    operationId: randomUUID(),
    compositionRevision: workspace.composition().revision,
    taskId: seedTask.id,
    expectedRevision: workspace.read(seedTask.id).revision,
    actionId,
    input,
  });

try {
  await command({
    type: "request",
    operationId: randomUUID(),
    text: REQUEST_ADD_TAGS,
  });
  const first = await publishPhase("add-tags-trim-reject");
  await action("setTags", { tags: "  Mixed " });
  assert.equal(workspace.read(seedTask.id).fields.tags, "Mixed");
  await assert.rejects(action("setTags", { tags: "   " }));

  formalBefore = formalWorkspaceFingerprint({
    composition: workspace.composition(),
    tasks: workspace.query(),
  });

  await command({
    type: "continue",
    operationId: randomUUID(),
    runId: first.id,
    baseVersion: first.versionId!,
    text: REQUEST_LOWERCASE_TAGS,
  });
  const second = await publishPhase("upgrade-tags-lowercase");
  assert.equal(second.parentRunId, first.id);
  await action("setTags", { tags: "  HeLLo " });
  assert.equal(workspace.read(seedTask.id).fields.tags, "hello");
  await assert.rejects(action("setTags", { tags: "  " }));

  evidence.push({
    passed: true,
    task: workspace.read(seedTask.id),
    composition: workspace.composition(),
  });
  console.log(
    "PASS: shortened real-model trial (add tags trim/reject → lowercase upgrade)",
  );
} catch (error) {
  const snapshot = await evolution.observe().catch(() => null);
  const failed = snapshot?.candidates?.find((c) => c.diagnostic);
  const run = snapshot?.run;
  evidence.push({
    passed: false,
    error: error instanceof Error ? error.message : String(error),
    breakpoint: buildBreakpoint({
      phase: currentPhase,
      runStatus: run?.status,
      diagnostic:
        failed?.diagnostic ??
        (run && "message" in run ? String(run.message) : undefined),
      preservedDirectory: directory,
    }),
  });
  throw error;
} finally {
  evidence.push({
    calls: workspace.db
      .prepare("SELECT runId,body FROM evolution_calls")
      .all()
      .map((r) => ({
        runId: r.runId,
        ...JSON.parse(String(r.body)),
      })),
  });
  await evolution.close();
  writeFileSync(
    join(directory, "issue-33-shortened-evidence.json"),
    JSON.stringify(redactSensitive(evidence), null, 2),
  );
  await workspace.close();
}
