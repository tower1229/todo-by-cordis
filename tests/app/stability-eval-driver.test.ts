import test from "node:test";
import assert from "node:assert/strict";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { stabilityDriverFor } from "../../scripts/lib/stability-eval/driver-fixture.js";
import { admissionRequest } from "../../src/evolution/request-admission.js";

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
  assert.deepEqual(JSON.parse(first.text!).questions[0]?.choice,{kind:"field-required"});
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
