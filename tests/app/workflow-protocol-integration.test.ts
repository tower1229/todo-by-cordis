import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { candidateScope, candidateSource } from "./evolution-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";
import type { BrowserEvidence } from "../../src/shared/browser-cases.js";
import { candidateProgramHash } from "../../src/server/browser-acceptance.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";

for (const inheritEntry of [false, true])
  test(
    inheritEntry
      ? "模型桩：仅修改宿主规格继承空业务源码，派生界面后通过浏览器和独立应用门禁"
      : "模型桩：宿主协议不修补错误业务结果，同一冻结要求和预算内修正后才通过浏览器及独立应用门禁",
    async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "host-workflow-full-gate-"),
      );
      const workspace = await Workspace.open(join(directory, "workspace.db"), {
        workflowProtocolOwner: "host",
      });
      if (inheritEntry) {
        const initial = {
          ...(workspace.activeVersion().definition as WorkflowDefinition),
          fields: [],
        };
        const files = {
          "business/entry.ts": "export default {};",
          "business/view.ts": `export default ${JSON.stringify({ title: initial.name, fields: [] })};`,
          "business/config.json": "{}",
          "business/compatibility.json": '{"preserveUnknownFields":true}',
        };
        const bundle = await workspace.release.buildBundle(
          files,
          "",
          new AbortController().signal,
        );
        const base = workspace.release.record({
          pluginId: initial.id,
          name: initial.name,
          service: "workflow",
          contractVersion: "workflow/1",
          definition: initial,
          source: JSON.stringify({
            files: Object.entries(files).map(([path, content]) => ({
              path,
              content,
            })),
          }),
          code: bundle.outputs["business/entry.js"],
          bundle,
          workflowProtocol: {
            version: "host-workflow/1",
            definition: initial,
            rules: [],
          },
          evidence: {
            passed: true,
            origin: "pretrusted-synthetic-base",
            rules: [],
          },
        });
        await workspace.activate(
          {
            versionId: base.id,
            compositionRevision: workspace.composition().revision,
            operationId: "seed",
          },
          () => undefined,
        );
      }
      const planner = new PlanningDriver();
      planner.finish = {
        workflowRules: [
          {
            key: "reflection",
            label: "复盘",
            required: true,
            minLength: 1,
            maxLength: 4,
          },
        ],
        writableScope: candidateScope,
      };
      let submitted = 0;
      const driver: Driver = {
        async generate(request, signal) {
          if (request.tools?.some((t) => t.name === "submit_candidate")) {
            submitted++;
            if (inheritEntry)
              return toolReply("submit_candidate", { files: [], members: [] });
            const source =
              submitted === 1
                ? `import type {WorkflowBusiness} from './contract.js';
const business:WorkflowBusiness={decide({action,input}){if(action==='complete')return {kind:'commit',state:'done',fields:{reflection:input.reflection}};}};
export default business;`
                : "export default {};";
            return toolReply(
              "submit_candidate",
              JSON.parse(candidateSource(source)),
            );
          }
          return planner.generate(request, signal);
        },
      };
      const domain = new EvolutionDomain(workspace);
      const evolution = new Evolution(workspace.db, driver, domain);
      t.after(async () => {
        await evolution.close();
        await workspace.close();
        await rm(directory, { recursive: true, force: true });
      });
      const settle = async () => {
        const until = Date.now() + 610_000;
        while (Date.now() < until) {
          const run = (await evolution.observe()).run;
          if (
            run &&
            !["planning", "executing", "applying"].includes(run.status)
          )
            return run;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("宿主协议候选未在原运行预算内结束");
      };
      const original = JSON.stringify({
        composition: workspace.composition(),
        tasks: workspace.query(),
      });
      await evolution.command({
        type: "request",
        text: "完成前必填复盘，去掉首尾空格后至少1个最多4个Unicode码点，重新打开保留，其他行为不变",
        operationId: "request",
      });
      const ready = await settle();
      assert.equal(ready.status, "ready", JSON.stringify(ready));
      if (ready.status !== "ready") return;
      assert.equal(ready.plan.binding?.workflowProtocol?.owner, "host");
      await evolution.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: "start",
      });
      const done = await settle();
      assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
      const snapshot = await evolution.observe();
      assert.equal(snapshot.candidates?.length, inheritEntry ? 1 : 2);
      const passed = snapshot.candidates!.at(-1)!;
      if (!inheritEntry) {
        const failed = snapshot.candidates![0];
        assert.equal(failed.passed, false);
        assert.match(failed.diagnostic ?? "", /complete-preserve-fields/);
        assert.equal(failed.requirementSeal, passed.requirementSeal);
      }
      assert.equal(passed.passed, true);
      assert.ok(passed.versionId);
      assert.ok(passed.evidenceHash);
      assert.equal(done.budget!.callsUsed + done.budget!.callsRemaining, 12);
      assert.equal(done.budget!.candidatesRemaining, inheritEntry ? 2 : 1);
      assert.equal(
        JSON.stringify({
          composition: workspace.composition(),
          tasks: workspace.query(),
        }),
        original,
      );
      const version = workspace.release.get(passed.versionId!);
      if (inheritEntry) {
        assert.equal(
          version.bundle!.files["business/entry.ts"],
          "export default {};",
        );
        assert(passed.delta?.files.some((f) => f.key === "business/view.ts"));
        assert(!passed.delta?.files.some((f) => f.key === "business/entry.ts"));
      }
      assert.equal(version.workflowProtocol?.version, "host-workflow/1");
      assert.deepEqual(
        version.workflowProtocol!.rules,
        ready.plan.workflowRules,
      );
      const evidence = version.evidence as { browser: BrowserEvidence };
      assert(evidence.browser.results.every((r) => r.status === "passed"));
      assert.deepEqual(
        [
          ...new Set(evidence.browser.results.map((r) => r.viewport.width)),
        ].sort((a, b) => a - b),
        [390, 1280],
      );
      domain.verifyAcceptance(version.id, ready.plan);
      const { id: _id, entry: _entry, createdAt: _time, ...artifact } = version;
      const altered = workspace.release.record({
        ...artifact,
        workflowProtocol: {
          ...version.workflowProtocol!,
          rules: version.workflowProtocol!.rules.map((r) => ({
            ...r,
            maxLength: r.maxLength + 1,
          })),
        },
      });
      const forged = workspace.release.record({
        ...artifact,
        workflowProtocol: altered.workflowProtocol,
        evidence: {
          ...evidence,
          browser: {
            ...evidence.browser,
            candidateProgramHash: candidateProgramHash(workspace, altered),
          },
        },
      });
      assert.throws(
        () => domain.verifyAcceptance(forged.id, ready.plan),
        /协议.*冻结|冻结.*协议/,
      );
      await evolution.command({
        type: "apply",
        runId: ready.id,
        candidateId: passed.id,
        evidenceHash: passed.evidenceHash!,
        compositionRevision: workspace.composition().revision,
        operationId: "apply",
      });
      assert.equal((await settle()).status, "succeeded");
      assert.equal(workspace.activeVersion().id, version.id);
    },
  );
