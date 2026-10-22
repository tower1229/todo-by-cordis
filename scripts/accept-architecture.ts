import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { verifyWorkflow } from "../src/server/workflow-acceptance.js";
import { DeepSeek } from "../src/evolution/deepseek.js";
import { admissionResolved } from "../src/evolution/request-admission.js";
import { createApp } from "../src/server/app.js";
import {
  browserEnvironment,
  verifyBrowser,
} from "../src/server/browser-acceptance.js";
import { hash } from "../src/release/storage.js";
import { activateWorkflowOnly } from "../tests/app/dual-composition-fixture.js";
import { panelPluginCode } from "../tests/fixtures/member-ui.js";
import { panelMemberCases } from "../tests/app/member-case-fixtures.js";
import { redactSensitive } from "./lib/shortened-real-model.js";

if (!process.argv.includes("--authorize-real-model"))
  throw new Error("需要明确授权真实 DeepSeek 外发与调用成本");
if (existsSync(".env")) process.loadEnvFile(".env");
const key = process.env.DEEPSEEK_API_KEY?.trim();
if (!key) throw new Error("DEEPSEEK_API_KEY 未配置");
assert.deepEqual(
  browserEnvironment().missing,
  [],
  "运行前必须已有前端产物、Chromium 和检查器",
);
const cases = [
  {
    id: "workflow",
    request:
      "请改进完成流程：完成前必须填写复盘，去掉首尾空白后至少1个、最多100个Unicode码点；重新打开保留复盘。已有和新增任务都适用，当前状态、其他动作、任务数据及未知字段行为不变。",
  },
  {
    id: "addition",
    request:
      "请新增独立的评审备注插件：所有任务状态均可通过填写评审备注动作输入文本，保存时去掉首尾空格，拒绝空白并保留原值；错误文案只须可理解，不要求特定文字。任务详情显示备注，尚未填写时显示空白，完成与重新打开后仍显示。已有和新增任务均适用，刷新及服务重启后原值保持。保留原完成/重新打开流程、标题、原备注、其他字段与数据行为。",
  },
  {
    id: "upgrade",
    request:
      "请只升级现有 panel 备注面板：未完成任务点击原 markNote 动作后，将 noteMark 写入值从 ok 改为 reviewed；已有 ok 不自动替换，已完成任务仍不可执行。详情原 note-panel 的 noteMark 字段显示保存值，刷新和重启后保持；原动作及贡献ID不变。保留主工作流、其他成员、其他字段及数据。",
  },
  {
    id: "clarification",
    request:
      "请改进完成流程，在完成前填写复盘。复盘是否必填尚未决定，请先集中问我这一项；其他行为沿用现有工作流。",
    answer:
      "复盘必填，去掉首尾空格后至少1个、最多100个Unicode码点，重新打开保留复盘；已有与新增任务均适用，其他字段和行为不变。",
  },
] as const;
const directory = mkdtempSync(resolve(".runtime/architecture-real-"));
const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(join(root, entry.name))
        : [join(root, entry.name)],
    )
    .sort();
const manifest = () =>
  Object.fromEntries(
    files("src").map((path) => [
      path,
      hash(readFileSync(path).toString("base64")),
    ]),
  );
const frozenSource = manifest();
const header = {
  kind: "architecture-real/9",
  model: "deepseek-flash",
  cases,
  limits: {
    callsPerRun: 12,
    candidates: 3,
    milliseconds: 600000,
    totalCalls: 48,
  },
  externalRetries: 0,
  manualCandidateEdits: 0,
  productionDatabaseAccess: false,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  sourceManifest: frozenSource,
  browser: browserEnvironment(),
};
const save = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(redactSensitive(value), null, 2), {
    mode: 0o600,
  });
save(join(directory, "header.json"), header);
writeFileSync(
  join(directory, "source-diff.patch"),
  execFileSync("git", ["diff"], { encoding: "utf8" }),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, "runner.ts"),
  readFileSync(new URL(import.meta.url)),
  { mode: 0o600 },
);
// Include uncommitted and newly added host modules; a Git diff alone omits them.
for (const path of [
  "src",
  "tests/fixtures",
  "tests/app/dual-composition-fixture.ts",
  "tests/app/member-case-fixtures.ts",
  "scripts/lib/shortened-real-model.ts",
  "package.json",
  "pnpm-lock.yaml",
])
  cpSync(path, join(directory, "source", path), { recursive: true });
const summaries: Record<string, unknown>[] = [];
let totalCalls = 0;
let providerContractRejected = false;
for (const scenario of cases) {
  const events: unknown[] = [];
  const log = (value: unknown) => {
    events.push({ at: new Date().toISOString(), value });
    save(join(directory, scenario.id + "-events.json"), events);
  };
  const w = await Workspace.open(join(directory, scenario.id + ".db"));
  const model = new DeepSeek(key);
  const domain = new EvolutionDomain(w);
  let calls = 0;
  let answered = false;
  let failure: string | undefined;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal, onTransport) {
        calls++;
        totalCalls++;
        assert.ok(calls <= 12 && totalCalls <= 48);
        console.log(
          JSON.stringify({
            case: scenario.id,
            call: calls,
            review: !!request.schema,
          }),
        );
        log({ type: "call-start", call: calls, review: !!request.schema });
        const result = await model.generate(request, signal, onTransport);
        log({
          type: "call-end",
          call: calls,
          usage: result.usage,
          model: {requested:result.transport?.requestedModel,actual:result.transport?.actualModel},
          tools: result.calls.map((c) => c.name),
        });
        return result;
      },
    },
    domain,
  );
  const app = createApp(w, e);
  const command = async (value: Record<string, unknown>) => {
    const response = await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...value, operationId: randomUUID() }),
    });
    const body: unknown = await response.json();
    log({ type: "command", command: value, status: response.status, body });
    assert.equal(response.status, 200, JSON.stringify(body));
  };
  const settle = async () => {
    let last = "";
    for (;;) {
      const snapshot = await e.observe();
      const status = snapshot.run?.status;
      if (status !== last) {
        console.log(
          JSON.stringify({
            case: scenario.id,
            status,
            budget: snapshot.run?.budget,
          }),
        );
        last = status ?? "";
      }
      if (!["planning", "executing", "applying"].includes(status ?? ""))
        return snapshot;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  let before = "";
  try {
    await activateWorkflowOnly(w);
    if (scenario.id === "upgrade") {
      const base = w.activeVersion();
      const source = await panelPluginCode();
      const panel = w.release.record({
        pluginId: "panel",
        name: "备注面板",
        service: "plugin:panel",
        contractVersion: "extensions/1",
        source,
        code: source,
        definition: { id: "panel" },
        evidence: { passed: true, origin: "synthetic-baseline" },
      });
      const composition = w.release.record({
        pluginId: base.pluginId,
        name: base.name,
        service: "workflow",
        contractVersion: "workflow/1",
        source: base.source,
        code: base.code,
        definition: base.definition,
        members: [
          {
            pluginId: base.pluginId,
            versionId: base.id,
            role: "workflow",
            enabled: true,
          },
          {
            pluginId: "panel",
            versionId: panel.id,
            role: "auxiliary",
            enabled: true,
          },
        ],
        evidence: {
          passed: true,
          origin: "synthetic-baseline",
          rules: [],
          memberCases: panelMemberCases,
        },
      });
      await w.activate(
        {
          versionId: composition.id,
          compositionRevision: w.composition().revision,
          operationId: randomUUID(),
        },
        () => undefined,
      );
    }
    const base = w.activeVersion();
    const runtime = await w.release.start(base);
    try {
      const definition = await runtime.invoke("describe");
      assert.deepEqual(definition, base.definition);
      log({
        type: "baseline-verified",
        checks: await verifyWorkflow(runtime, definition, base, {
          pluginId: base.pluginId,
          name: base.name,
          fields: [],
        }),
      });
    } finally {
      await runtime.close();
    }
    await w.command({
      type: "create",
      operationId: randomUUID(),
      compositionRevision: w.composition().revision,
      title: "真实API隔离基线任务",
    });
    before = JSON.stringify({ composition: w.composition(), tasks: w.query() });
    await command({ type: "request", text: scenario.request });
    let snapshot = await settle();
    if (scenario.id === "addition") {
      assert.equal(snapshot.run?.status,"blocked","明确不支持的初始空白必须提前阻塞");
      assert.ok(snapshot.run && "message" in snapshot.run && /维护者.*初始|初始.*维护者/.test(snapshot.run.message));
      assert.ok(calls <= 4,"来源预检和独立来源裁决各含最多一次原预算内协议纠正，不进入完整规划");
      const admission = snapshot.run.requestAdmissions?.at(-1);
      assert.ok(admission && admissionResolved(admission) && admission.blockers.length > 0, "早期能力阻塞必须含完整来源裁决");
      assert.equal(snapshot.candidates?.length,0);
      log({type:"unsupported-requirement-blocked-early",run:snapshot.run});
      continue;
    }
    if (scenario.id === "clarification") {
      assert.equal(
        snapshot.run?.status,
        "awaiting-input",
        "此例必须实际经过必要澄清",
      );
      if (snapshot.run?.status !== "awaiting-input")
        throw new Error("澄清路径缺失");
      assert.match(snapshot.run.question, /复盘|必填|选填/);
      const runId = snapshot.run.id;
      const used = snapshot.run.budget!.callsUsed;
      await command({ type: "answer", runId, text: scenario.answer });
      answered = true;
      snapshot = await settle();
      assert.equal(snapshot.run?.id, runId);
      assert.ok(snapshot.run!.budget!.callsUsed > used);
    }
    if (snapshot.run?.status === "awaiting-acceptance") {
      const r = snapshot.run;
      await command({
        type: "confirm-acceptance",
        runId: r.id,
        planId: r.plan.id,
        revisionId: r.acceptanceRevision.id,
      });
      snapshot = await settle();
    }
    assert.equal(
      snapshot.run?.status,
      "ready",
      JSON.stringify(
        snapshot.run && {
          status: snapshot.run.status,
          message: "message" in snapshot.run ? snapshot.run.message : undefined,
        },
      ),
    );
    if (snapshot.run?.status !== "ready") throw new Error("规划未就绪");
    assert.equal(snapshot.run.plan.changeSpec?.version, "change/3");
    const obligations = snapshot.run.plan.requirements!.flatMap(
      (r) => r.obligations ?? [],
    );
    if (scenario.id === "addition") {
      const field = obligations.find(
        (o) => o.kind === "field" && o.member !== "workflow",
      );
      assert.ok(
        field?.kind === "field",
        "独立语义门槛：详情备注必须有字段义务",
      );
      assert.deepEqual(
        field.initial,
        { kind: "visible", value: "" },
        "独立语义门槛：用户明确要求尚未填写显示空白",
      );
    }
    if (scenario.id === "upgrade") {
      assert.ok(
        obligations.some(
          (o) =>
            (o.kind === "field" || o.kind === "history") &&
            o.field === "noteMark" &&
            o.member === "panel" &&
            o.history?.expected.fields.noteMark === "ok",
        ),
        "独立语义门槛：旧 ok 必须经过基础版本页面准备",
      );
    }
    await command({
      type: "start",
      runId: snapshot.run.id,
      planId: snapshot.run.plan.id,
    });
    snapshot = await settle();
    assert.equal(
      snapshot.run?.status,
      "awaiting-apply",
      JSON.stringify(snapshot.run),
    );
    if (snapshot.run?.status !== "awaiting-apply")
      throw new Error("候选未通过");
    const candidate = snapshot.candidates!.find((c) => c.passed)!;
    assert.ok(candidate.evidenceHash && candidate.browser?.results.length);
    domain.verifyAcceptance(candidate.versionId!, snapshot.run.plan);
    if (scenario.id === "addition") {
      const field = snapshot.run.plan
        .requirements!.flatMap((r) => r.obligations ?? [])
        .find((o) => o.kind === "field" && o.member !== "workflow")!;
      if (field.kind !== "field") throw new Error("field expected");
      const independent = await verifyBrowser(
        w,
        w.release.get(candidate.versionId!),
        base,
        ["existing", "new"].map((task) => ({
          id: `independent-unfilled-${task}`,
          task: task as "existing" | "new",
          steps: [
            {
              kind: "field",
              member: field.member,
              ...(field.contribution
                ? { contribution: field.contribution }
                : {}),
              field: field.field,
              value: "",
            },
          ],
        })),
        [],
        "independent-original-empty-requirement",
        new AbortController().signal,
      );
      log({
        type: "independent-original-requirement-passed",
        evidence: independent,
      });
    }
    assert.equal(
      JSON.stringify({ composition: w.composition(), tasks: w.query() }),
      before,
    );
    assert.deepEqual(manifest(), frozenSource);
    log({ type: "passed-awaiting-independent-apply", candidate, snapshot });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    log({ type: "failed", error: failure });
  } finally {
    const snapshot = await e.observe();
    save(join(directory, scenario.id + "-snapshot.json"), snapshot);
    const callRecords = w.db.prepare("SELECT runId,body FROM evolution_calls").all().map(row=>({runId:row.runId,...JSON.parse(String(row.body))}));
    providerContractRejected ||= callRecords.some(c=>c.httpStatus === 400);
    const formalSyntheticUnchanged = JSON.stringify({composition:w.composition(),tasks:w.query()}) === before;
    const sourceUnchanged = JSON.stringify(manifest()) === JSON.stringify(frozenSource);
    if (!formalSyntheticUnchanged || !sourceUnchanged) failure ??= "冻结源码或合成基线发生变化，验收无效";
    save(
      join(directory, scenario.id + "-calls.json"),
      callRecords,
    );
    const summary = {
      case: scenario.id,
      runId: snapshot.run?.id,
      passed: !failure && snapshot.run?.status === "awaiting-apply",
      boundaryAccepted: scenario.id === "addition" && !failure && snapshot.run?.status === "blocked",
      providerContractRejected,
      status: snapshot.run?.status,
      error: failure,
      calls,
      budget: snapshot.run?.budget,
      answeredSyntheticClarification: answered,
      formalSyntheticUnchanged,
      sourceUnchanged,
      applied: false,
      candidates: snapshot.candidates?.map((c) => ({
        id: c.id,
        passed: c.passed,
        diagnostic: c.diagnostic,
        evidence: c.browser?.directory,
      })),
    };
    summaries.push(summary);
    save(join(directory, "summary.json"), {
      directory,
      totalCalls,
      passed: summaries.length === 4 && summaries.every((s) => s.passed || s.boundaryAccepted),
      summaries,
      notRun: providerContractRejected ? cases.slice(summaries.length).map(c=>c.id) : [],
    });
    console.log(JSON.stringify(summary));
    await e.close();
    await w.close();
  }
  if (providerContractRejected) break;
}
console.log(
  JSON.stringify({
    directory,
    totalCalls,
    passed: summaries.length === cases.length && summaries.every((s) => s.passed || s.boundaryAccepted),
  }),
);
if (summaries.length !== cases.length || !summaries.every((s) => s.passed || s.boundaryAccepted)) process.exitCode = 1;
