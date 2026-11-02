import test from "node:test";
import assert from "node:assert/strict";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { stabilityDriverFor } from "../../scripts/lib/stability-eval/driver-fixture.js";
import { admissionRequest } from "../../src/evolution/request-admission.js";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { settleEvolution } from "./evolution-adapter.js";
import type { ModelRequest } from "../../src/evolution/driver.js";

for (const id of ["missing-capability-push", "unsupported-blank-presentation"])
  test(`边界模型桩从规划报告阻断，经原生独立来源审查才阻塞：${id}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-boundary-driver-"));
    const workspace = await Workspace.open(join(directory, "workspace.db"));
    const scenario = currentManifest("a".repeat(40)).scenarios.find(s => s.id === id)!;
    const fixture = stabilityDriverFor(id, scenario);
    const requests: ModelRequest[] = [];
    const evolution = new Evolution(workspace.db, {async generate(request, signal) {
      requests.push(structuredClone(request));
      return fixture.generate(request, signal);
    }}, new EvolutionDomain(workspace));
    t.after(async () => {
      await evolution.close();
      await workspace.close();
      await rm(directory, {recursive:true,force:true});
    });
    const before = {composition:workspace.composition(),tasks:workspace.query()};
    await evolution.command({type:"request",operationId:"boundary",text:scenario.request});
    const run = await settleEvolution(evolution);
    assert.equal(run.status, "blocked", JSON.stringify(run));
    assert.deepEqual(requests.map(request => request.phase), ["planning", "admission", "review"]);
    assert.equal(requests[2].tools, undefined);
    assert.deepEqual(requests[2].history, []);
    assert.equal(run.budget?.callsUsed, 3);
    assert.ok(run.requestAdmissions?.at(-1)?.semanticReview);
    assert.equal(workspace.db.prepare("SELECT count(*) n FROM evolution_calls").get()!.n, 3);
    assert.equal(workspace.db.prepare("SELECT count(*) n FROM evolution_requirement_freezes").get()!.n, 0);
    assert.equal((await evolution.observe()).candidates?.length, 0);
    assert.deepEqual({composition:workspace.composition(),tasks:workspace.query()}, before);
  });

test("当前澄清模型桩在来源预检阶段提出已冻结的未决项，回答后不再次提问", async () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(s => s.id === "clarification-reflection")!;
  const driver = stabilityDriverFor(scenario.id, scenario);
  const request = (answered: boolean) => admissionRequest([
      { id: "run:1", text: scenario.request },
      ...(answered ? [{ id: "run:2", text: scenario.clarification!.answer }] : []),
    ],[]);
  const first = await driver.generate(request(false), new AbortController().signal);
  const index=JSON.parse(first.text!).questions[0]?.sourceItem;
  assert.equal(JSON.parse(request(false).message!).sourceItems[index-1].text, "复盘是否必填尚未决定");
  assert.equal(JSON.parse(first.text!).questions[0]?.sourceQuote, undefined);
  assert.deepEqual(JSON.parse(first.text!).questions[0]?.choice,{ kind: "field-required" as const, scope: "action-input" as const, action: "complete", field: { kind: "new" as const, name: "复盘" } });
  assert.equal(JSON.parse(first.text!).questions[0]?.question,undefined);
  const second = await driver.generate(request(true), new AbortController().signal);
  assert.deepEqual(JSON.parse(second.text!).questions, []);
});
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
} from "../../scripts/lib/stability-eval/manifest.js";
test("桩层截止时间场景记录现有阻塞且不生成候选实现", async () => {
  // Browser path needs dist/web; this unit seam exercises driver+workspace only via a dry header freeze check.
  const scenario = STABILITY_EVAL_MANIFEST.scenarios.find(
    (s) => s.id === "due-auto-expire",
  )!;
  assert.equal(scenario.expectedOutcomeClass, "current-blocker");
  const driver = stabilityDriverFor("due-auto-expire");
  const first = await driver.generate(
    {
      instruction: "plan",
      history: [],
      tools: [{ name: "inspect_application", description: "", parameters: {} }],
    },
    new AbortController().signal,
  );
  assert.equal(first.calls[0]?.name, "inspect_application");
  const clarified = await driver.generate(
    {
      instruction: "plan",
      history: [
        {
          parts: [
            {
              functionResponse: {
                name: "inspect_application",
                response: { result: {} },
              },
            },
          ],
        },
      ],
      tools: [
        { name: "request_clarification", description: "", parameters: {} },
        { name: "propose_plan", description: "", parameters: {} },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(clarified.calls[0]?.name, "request_clarification");
  await assert.rejects(
    () =>
      driver.generate(
        {
          instruction: "generate",
          history: [],
          tools: [{ name: "submit_candidate", description: "", parameters: {} }],
        },
        new AbortController().signal,
      ),
    /不得生成候选/,
  );
  const frozen = freezeManifest(STABILITY_EVAL_MANIFEST);
  assert.equal(frozen.sourceCommit, STABILITY_EVAL_MANIFEST.sourceCommit);
});

test("清单冻结文件在套件启动时写入且含 contentHash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-stability-manifest-"));
  try {
    const frozen = freezeManifest(STABILITY_EVAL_MANIFEST);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(directory, "manifest.frozen.json"),
      JSON.stringify(frozen, null, 2),
    );
    const loaded = JSON.parse(
      await readFile(join(directory, "manifest.frozen.json"), "utf8"),
    );
    assert.equal(loaded.frozen, true);
    assert.equal(loaded.contentHash, frozen.contentHash);
    assert.equal(loaded.scenarios.length, 7);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
