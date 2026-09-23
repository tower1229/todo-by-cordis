import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
} from "../../scripts/lib/stability-eval/manifest.js";
import { stabilityDriverFor } from "../../scripts/lib/stability-eval/driver-fixture.js";

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
