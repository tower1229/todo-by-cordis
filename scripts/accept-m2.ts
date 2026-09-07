import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { Gemini } from "../src/evolution/gemini.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
process.loadEnvFile(".env");
const directory =
  process.env.ACCEPTANCE_PATH ?? `.runtime/acceptance-${Date.now()}`;
mkdirSync(directory, { recursive: true });
const w = await Workspace.open(`${directory}/workspace.db`);
const e = new Evolution(
  w.db,
  new Gemini(process.env.GEMINI_API_KEY!),
  new EvolutionDomain(w),
);
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(`${directory}/${entry.name}`)
      : [`${directory}/${entry.name}`],
  );
const sourceManifest = Object.fromEntries(
  files("src")
    .sort()
    .map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
);
const evidence: unknown[] = [
  {
    model: "gemini-3.1-pro-preview",
    startedAt: new Date().toISOString(),
    sourceManifest,
  },
];
const wait = async () => {
  let old = "";
  for (;;) {
    const run = (await e.observe()).run!;
    const status =
      run.status + ("steps" in run ? `:${run.steps.at(-1)?.label}` : "");
    if (status !== old) {
      console.log(status);
      old = status;
    }
    if (!["planning", "executing"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 1000));
  }
};
try {
  const task = (
    await w.command({
      type: "create",
      title: "真实自迭代验收",
      operationId: randomUUID(),
      compositionRevision: 1,
    })
  ).task!;
  for (const request of ["完成前写一句复盘", "复盘至少十个字"]) {
    await e.command({
      type: "request",
      text: request,
      operationId: randomUUID(),
    });
    const plan = await wait();
    evidence.push(plan);
    if (plan.status !== "awaiting-confirmation")
      throw new Error(JSON.stringify(plan));
    console.log(JSON.stringify(plan.plan));
    await e.command({
      type: "confirm",
      runId: plan.id,
      planId: plan.plan.id,
      compositionRevision: plan.plan.compositionRevision,
      operationId: randomUUID(),
    });
    const run = await wait();
    evidence.push(run);
    if (run.status !== "succeeded") throw new Error(JSON.stringify(run));
    const active = w.activeVersion();
    evidence.push(active);
    console.log(`APPLIED ${active.pluginId} ${active.id}`);
    const act = (input?: Record<string, string>, actionId = "complete") =>
      w.command({
        type: "action",
        taskId: task.id,
        expectedRevision: w.read(task.id).revision,
        compositionRevision: w.composition().revision,
        operationId: randomUUID(),
        actionId,
        input,
      });
    const field = w.composition().workflow.fields[0].key;
    assert.equal((await act()).decision?.kind, "input-required");
    assert.equal(w.read(task.id).state, "open");
    if (request.includes("十")) await assert.rejects(act({ [field]: "太短" }));
    await act({ [field]: "今天完成了任务并总结了有效的方法" });
    assert.equal(w.read(task.id).state, "done");
    evidence.push(w.read(task.id));
    await act(undefined, "reopen");
  }
  const second = w.activeVersion();
  const first = w.release.get(second.parentId!);
  assert.equal(first.pluginId, second.pluginId);
  assert.notEqual(first.source, second.source);
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--no-index",
      "--",
      join(dirname(first.entry), "source.ts"),
      join(dirname(second.entry), "source.ts"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(diff.status, 1);
  writeFileSync(`${directory}/source.diff`, diff.stdout);
  await w.activate({
    versionId: first.id,
    compositionRevision: w.composition().revision,
    operationId: randomUUID(),
  });
  assert.ok(Object.values(w.read(task.id).fields).length);
  evidence.push({ restored: first.id, task: w.read(task.id) });
  console.log(`PASS ${directory}`);
} finally {
  evidence.push({
    calls: w.db
      .prepare("SELECT runId,body FROM evolution_calls")
      .all()
      .map((r) => ({ runId: r.runId, ...JSON.parse(String(r.body)) })),
    candidates: w.db
      .prepare("SELECT runId,body FROM evolution_candidates")
      .all()
      .map((r) => ({ runId: r.runId, ...JSON.parse(String(r.body)) })),
  });
  writeFileSync(
    `${directory}/evidence.json`,
    JSON.stringify(evidence, null, 2),
  );
  await e.close();
  await w.close();
}
