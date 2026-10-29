import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
} from "../../scripts/lib/stability-eval/manifest.js";
import { runStabilityScenario } from "../../scripts/lib/stability-eval/scenario.js";
import { computeStabilityMetrics } from "../../scripts/lib/stability-eval/metrics.js";
import type { ScenarioRunRecord } from "../../scripts/lib/stability-eval/metrics.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { evaluateSuite } from "../../scripts/lib/stability-eval/report.js";
import { BudgetExhaustedError } from "../../src/evolution/budget.js";
import { runStabilityBrowserPath, type BrowserPathResult } from "../../scripts/lib/stability-eval/browser.js";
import { stabilityDriverFor } from "../../scripts/lib/stability-eval/driver-fixture.js";

test.describe.configure({ mode: "serial" });

const records: ScenarioRunRecord[] = [];

for (const phase of ["planning", "generation"] as const)
  test(`预算暂停即归档真实状态，不继续等待候选：${phase}`, async ({}, testInfo) => {
    test.setTimeout(45_000);
    const directory = await mkdtemp(join(tmpdir(), `cordis-budget-observation-${phase}-`));
    const current = currentManifest("a".repeat(40));
    const scenario = current.scenarios.find(s => s.id === "tags-add")!;
    const fixture = stabilityDriverFor(scenario.id, scenario);
    const manifest = freezeManifest({ ...current, scenarios: [scenario], runs: { ...current.runs, independentRunsPerScenario: 1 } });
    let stoppedCalls = 0;
    try {
      const result = await runStabilityScenario({
        directory, scenario, manifest, evidenceKind: "model-stub",
        driver: { async generate(request, signal, onTransport) {
          if (request.phase === phase) {
            stoppedCalls++;
            throw new BudgetExhaustedError("合成阶段时间窗口耗尽，保留验收时间", "milliseconds", phase);
          }
          return fixture.generate(request, signal, onTransport);
        } },
        // Test only the observer deadline; the native host keeps the frozen budget.
        browserRun: input => runStabilityBrowserPath({ ...input, budgetMs: 0 }),
      });
      const events = (await readFile(result.eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
        type: string;
        run?: { status: string; budget: { grants: unknown[] } };
        browser?: BrowserPathResult;
      });
      const settled = events.find(event => event.type === "settled");
      if (!settled?.run || !settled.browser) throw new Error("缺少真实暂停及浏览器归档");
      expect(settled.run.status).toBe("awaiting-budget");
      expect(settled.browser.observedRunStatus).toBe("awaiting-budget");
      expect(settled.browser.message).toContain("合成阶段时间窗口耗尽");
      expect(settled.browser.message).not.toContain("Timeout");
      expect(settled.browser.confirmedPlan ?? false).toBe(phase === "generation");
      expect(settled.browser.status).toBe("failed");
      expect(stoppedCalls).toBe(1);
      expect(settled.run.budget.grants).toEqual([]);
      expect(result.record.fullPathSucceeded).toBe(false);
      expect(result.record.evidenceComplete).toBe(true);
      expect(result.record.resources?.candidates).toBe(0);
      expect(settled.browser.applied ?? false).toBe(false);
      expect(result.record.terminal?.stop?.code).toBe("phase-time-reserve");
      const archive = JSON.parse(await readFile(join(directory, "workspace-evidence.json"), "utf8")) as {
        database: Record<string, unknown[]>;
      };
      expect(archive.database.evolution_requirement_freezes).toHaveLength(phase === "generation" ? 1 : 0);
      expect(archive.database.evolution_candidates).toHaveLength(0);
    } finally {
      await cp(directory, testInfo.outputPath("budget-evidence"), { recursive: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const scenario of STABILITY_EVAL_MANIFEST.scenarios) {
  test(`稳定性基线桩层浏览器路径：${scenario.id}`, async () => {
    test.setTimeout(300_000);
    const directory = await mkdtemp(
      join(tmpdir(), `cordis-stability-${scenario.id}-`),
    );
    try {
      const manifest = freezeManifest(STABILITY_EVAL_MANIFEST);
      const result = await runStabilityScenario({
        directory,
        scenario,
        manifest,
        evidenceKind: "model-stub",
      });
      expect(result.record.evidenceKind).toBe("model-stub");
      expect(result.record.scenarioId).toBe(scenario.id);
      expect(
        result.record.observedOutcomeClass,
        (await readFile(result.eventsPath, "utf8"))
          .split("\n")
          .filter(
            (line) =>
              line.includes('"type":"settled"') ||
              line.includes('"type":"archive-error"'),
          )
          .join("\n"),
      ).toBe(scenario.expectedOutcomeClass);
      expect(result.record.fullPathSucceeded).toBe(
        scenario.expectedOutcomeClass === "full-path-success",
      );

      const events = await readFile(result.eventsPath, "utf8");
      expect(events).toContain('"evidenceKind":"model-stub"');
      expect(events).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(events).not.toMatch(/(?:GEMINI|DEEPSEEK)_API_KEY/);

      const settled = events
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as {
              type?: string;
              browser?: {
                experienced?: boolean;
                applied?: boolean;
                recoveryEntryVisible?: boolean;
                experienceActions?: {
                  tagSet?: string;
                  counterValue?: string;
                  reflectionSet?: string;
                  completedAndReopened?: boolean;
                };
              };
              run?: { blockReason?: string; message?: string };
            };
          } catch {
            return null;
          }
        })
        .find((e) => e?.type === "settled");
      expect(settled?.browser?.recoveryEntryVisible).toBe(true);

      if (scenario.requiresExperience) {
        expect(settled?.browser?.experienced).toBe(true);
        const actions = settled?.browser?.experienceActions;
        if (scenario.id === "tags-add")
          expect(actions?.tagSet).toBe("BrowserTag");
        if (scenario.id === "member-upgrade-tags")
          expect(actions?.tagSet).toBe("browsertag");
        if (scenario.id === "counter-add")
          expect(Number(actions?.counterValue)).toBeGreaterThanOrEqual(1);
        if (scenario.id === "rule-revision-reflection") {
          expect(actions?.reflectionSet).toBeTruthy();
          expect(actions?.completedAndReopened).toBe(true);
        }
      }
      if (scenario.requiresApply) expect(settled?.browser?.applied).toBe(true);

      if (scenario.id === "temporarily-unavailable-dependency") {
        expect(
          `${settled?.run?.blockReason ?? ""} ${settled?.run?.message ?? ""}`,
        ).toMatch(/investigation|protection|依赖/);
      }

      records.push(result.record);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("七场景桩层指标汇总列出分母", () => {
  expect(records.length).toBe(STABILITY_EVAL_MANIFEST.scenarios.length);
  const metrics = computeStabilityMetrics(records);
  expect(metrics.fullPathSuccessRate.denominator).toBe(7);
  expect(
    metrics.capabilitySelectionAccuracy.denominator,
  ).toBeGreaterThanOrEqual(1);
  expect(records.every((r) => r.evidenceKind === "model-stub")).toBe(true);
  expect(
    records.filter((r) => r.observedOutcomeClass === "full-path-success")
      .length,
  ).toBe(
    STABILITY_EVAL_MANIFEST.scenarios.filter(
      (s) => s.expectedOutcomeClass === "full-path-success",
    ).length,
  );
});

test("真实浏览器绑定不依赖 stub 的成员、动作和字段名称", async () => {
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-renamed-binding-"));
  const original = stabilityStubDriver("tags-add");
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          const reply = await original.generate(request, signal);
          const renamed = JSON.parse(
            JSON.stringify(reply)
              .replace(/\btags\b/g, "categorylabel")
              .replaceAll("setTags", "saveCategory")
              .replaceAll("设标签", "设置分类(+)")
              .replaceAll("标签", "分类"),
          ) as typeof reply;
          // Rename implementation identifiers while preserving exact user quotes.
          for (const call of renamed.calls) {
            if (call.name !== "propose_plan") continue;
            const originalRequirements = reply.calls.find(
              (c) => c.name === "propose_plan",
            )!.args.requirements as { quote: string }[];
            for (const [index, requirement] of (
              call.args.requirements as { quote: string }[]
            ).entries())
              requirement.quote = originalRequirements[index].quote;
          }
          return renamed;
        },
      },
    });
    expect(
      result.record.observedOutcomeClass,
      (await readFile(result.eventsPath, "utf8"))
        .split("\n")
        .filter((line) => line.includes('"type":"settled"'))
        .join("\n"),
    ).toBe("full-path-success");
    expect(result.record.capabilitySelectionCorrect).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const defect of [
  "missing-form",
  "missing-form-blank-reject",
  "lost-field",
] as const) {
  test(`浏览器启动的标签候选拦截 ${defect}`, async () => {
    const { stabilityStubDriver } = await import(
      "../../scripts/lib/stability-eval/driver-fixture.js"
    );
    const directory = await mkdtemp(
      join(tmpdir(), `cordis-tag-reject-${defect}-`),
    );
    const original = stabilityStubDriver("tags-add");
    try {
      const result = await runStabilityScenario({
        directory,
        scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
        manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
        evidenceKind: "model-stub",
        driver: {
          async generate(request, signal) {
            const reply = await original.generate(request, signal);
            return {
              ...reply,
              calls: reply.calls.map((call) => {
                if (
                  defect === "missing-form-blank-reject" &&
                  call.name === "propose_plan"
                ) {
                  const changes = call.args.changes as {
                    target: string;
                    cases: { name: string; input: Record<string, string> }[];
                  }[];
                  const member = changes.find((c) => c.target !== "workflow")!;
                  const memberCases = member.cases as {
                    name: string;
                    input: Record<string, string>;
                  }[];
                  return {
                    ...call,
                    args: {
                      ...call.args,
                      changes: changes.map((change) =>
                        change.target !== member.target
                          ? change
                          : {
                              ...member,
                              cases: memberCases.filter(
                                (testCase) =>
                                  testCase.name !== "缺失标签输入" ||
                                  Object.keys(testCase.input).length > 0,
                              ),
                            },
                      ),
                    },
                  };
                }
                if (call.name !== "submit_candidate") return call;
                const members = call.args.members as {
                  pluginId: string;
                  source: string;
                }[];
                return {
                  ...call,
                  args: {
                    ...call.args,
                    members: members.map((member) => {
                      const source =
                        defect !== "lost-field"
                          ? member.source.replace(
                              /return\s*\{\s*kind:\s*["']input-required["'][^;]*;/,
                              'return { kind: "reject", message: "缺失输入" };',
                            )
                          : member.source.replace(
                              /\{\s*\.\.\.task\.fields,\s*tags\s*\}/,
                              "{ tags }",
                            );
                      expect(source).not.toBe(member.source);
                      return { ...member, source };
                    }),
                  },
                };
              }),
            };
          },
        },
      });
      const events = await readFile(result.eventsPath, "utf8");
      const settled = events
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string;
              run?: { status?: string };
              candidates?: { passed: boolean; diagnostic?: string }[];
            },
        )
        .find((event) => event.type === "settled");
      const diagnostics =
        settled?.candidates
          ?.map((candidate) => candidate.diagnostic ?? "")
          .join("\n") ?? "";
      expect(result.record.fullPathSucceeded).toBe(false);
      expect(
        settled?.candidates?.every((candidate) => candidate.passed === false),
      ).toBe(true);
      expect(diagnostics).toMatch(
        defect !== "lost-field"
          ? /缺失输入须返回 input-required 表单/
          : /preserve-unknown-fields|标签保留未知字段/,
      );
      expect(settled?.run?.status).not.toBe("awaiting-apply");
      expect(events).not.toContain('"applied":true');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("浏览器中途遇到模型传输失败仍归档完整调用和真实失败分类", async () => {
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-browser-transport-"));
  const original = stabilityStubDriver("tags-add");
  let calls = 0;
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          if (++calls === 2)
            throw new Error("fetch failed: synthetic transport interruption");
          return original.generate(request, signal);
        },
      },
    });
    expect(result.record.failureClass).toBe("transport");
    expect(result.record.usage).toBeNull();
    expect(result.record.evidenceComplete).toBe(true);
    const events = (await readFile(result.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.type === "settled").browser
        .openedImprovePanel,
    ).toBe(true);
    expect(events.find((event) => event.type === "calls").count).toBe(2);
    expect(
      events.find((event) => event.type === "calls").samples.at(-1).status,
    ).toBe("failed");
    expect(
      await readFile(join(directory, "workspace-evidence.json"), "utf8"),
    ).toContain("synthetic transport interruption");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("慢规划与延迟发送响应不会把旧输入界面误判为方案已就绪", async () => {
  test.setTimeout(300_000);
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const { runStabilityBrowserPath } = await import(
    "../../scripts/lib/stability-eval/browser.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-slow-planning-"));
  const original = stabilityStubDriver("member-upgrade-tags");
  let calls = 0;
  try {
    const scenario = STABILITY_EVAL_MANIFEST.scenarios.find(
      (s) => s.id === "member-upgrade-tags",
    )!;
    const result = await runStabilityScenario({
      directory,
      scenario,
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          if (++calls === 2)
            await new Promise((resolve) => setTimeout(resolve, 6500));
          return original.generate(request, signal);
        },
      },
      browserRun: (input) =>
        runStabilityBrowserPath({
          ...input,
          configurePage: async (page) => {
            await page.route("**/api/assistant/commands", async (route) => {
              if (route.request().postDataJSON()?.type === "request")
                await new Promise((resolve) => setTimeout(resolve, 1000));
              await route.continue();
            });
          },
        }),
    });
    expect(result.record.observedOutcomeClass).toBe("full-path-success");
    expect(result.record.evidenceComplete).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("响应先超时、点击仍等待时也应捕获失败", async ({ page }) => {
  const { responseForAction } = await import(
    "../../scripts/lib/stability-eval/browser.js"
  );
  await expect(
    responseForAction(
      page,
      () => false,
      () => new Promise((resolve) => setTimeout(resolve, 100)),
      30,
    ),
  ).rejects.toThrow(/Timeout/);
});

for (const delayed of ["command", "snapshot"] as const)
  test(`打开体验的${delayed}响应超过五秒仍遵循宿主操作期限（模型桩）`, async () => {
    test.setTimeout(300_000);
    const { runStabilityBrowserPath } = await import(
      "../../scripts/lib/stability-eval/browser.js"
    );
    const scenario = STABILITY_EVAL_MANIFEST.scenarios.find(
      (item) => item.id === "counter-add",
    )!;
    const directory = await mkdtemp(join(tmpdir(), "cordis-slow-experience-"));
    let delayedResponses = 0;
    try {
      const result = await runStabilityScenario({
        directory,
        scenario,
        manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
        evidenceKind: "model-stub",
        browserRun: (input) => runStabilityBrowserPath({
          ...input,
          configurePage: async (page) => {
            await page.route((url) => delayed === "command"
              ? url.pathname === "/api/assistant/commands"
              : url.pathname === "/api/experience" && url.searchParams.has("sessionId"), async (route) => {
              if (delayed === "snapshot" || route.request().postDataJSON()?.type === "experience") {
                delayedResponses++;
                await new Promise((resolve) => setTimeout(resolve, delayed === "command" ? 16_500 : 6500));
              }
              await route.continue().catch(() => undefined);
            });
          },
        }),
      });
      expect(delayedResponses).toBe(1);
      expect(result.record.fullPathSucceeded, await readFile(result.eventsPath, "utf8")).toBe(true);
      expect(result.record.evidenceComplete).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const selected of currentManifest("a".repeat(40)).scenarios)
  test(`当前评测真实浏览器路径与独立达标判定（模型桩）：${selected.id}`, async () => {
    test.setTimeout(300000);
    const current = currentManifest("a".repeat(40));
    const scenario = current.scenarios.find((s) => s.id === selected.id)!;
    const manifest = freezeManifest({
      ...current,
      scenarios: [scenario],
      runs: { ...current.runs, independentRunsPerScenario: 1 },
    });
    const directory = await mkdtemp(join(tmpdir(), "cordis-current-path-"));
    try {
      const result = await runStabilityScenario({
        directory,
        scenario,
        manifest,
        evidenceKind: "model-stub",
        trialId: `${scenario.id}-r1`,
      });
      const events = await readFile(result.eventsPath, "utf8");
      expect(
        result.record.fullPathSucceeded,
        events
          .split("\n")
          .filter(
            (l) =>
              l.includes('"type":"settled"') ||
              l.includes('"type":"independent-oracle"'),
          )
          .join("\n"),
      ).toBe(scenario.expectedOutcomeClass === "full-path-success");
      expect(
        result.record.oracle?.checks.every((c) => c.status === "passed"),
      ).toBe(true);
      expect(evaluateSuite(manifest, [result.record]).acceptancePassed).toBe(
        true,
      );
      if (scenario.requiresExperience) {
        const browser = JSON.parse(
          await readFile(join(directory, "independent-browser.json"), "utf8"),
        );
        expect(
          browser.results.every(
            (r: { status: string }) => r.status === "passed",
          ),
        ).toBe(true);
        expect(browser.directory.startsWith(directory)).toBe(true);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test("模型桩复核自报通过但遗漏必填断言时，独立原文判定禁止执行和应用", async () => {
  test.setTimeout(120000);
  const { stabilityDriverFor } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const current = currentManifest("a".repeat(40));
  const scenario = current.scenarios.find(
    (s) => s.id === "rule-revision-reflection",
  )!;
  const manifest = freezeManifest({
    ...current,
    scenarios: [scenario],
    runs: { ...current.runs, independentRunsPerScenario: 1 },
  });
  const original = stabilityDriverFor(scenario.id, scenario);
  const directory = await mkdtemp(join(tmpdir(), "cordis-oracle-omission-"));
  try {
    const result = await runStabilityScenario({
      directory,
      scenario,
      manifest,
      evidenceKind: "model-stub",
      trialId: `${scenario.id}-r1`,
      driver: {
        async generate(request, signal, onTransport) {
          const reply = await original.generate(request, signal, onTransport);
          for (const call of reply.calls)
            if (call.name === "propose_plan") {
              const changes = call.args.changes as {
                fields?: { required: boolean; minLength: number }[];
              }[];
              for (const change of changes)
                for (const field of change.fields ?? []) {
                  field.required = false;
                  field.minLength = 0;
                }
            }
          return reply;
        },
      },
    });
    expect(
      result.record.oracle?.checks.find((c) => c.id === "plan:reflection")
        ?.status,
    ).toBe("failed");
    expect(
      result.record.oracle?.checks.find((c) => c.id === "plan:constraints")
        ?.status,
    ).toBe("failed");
    expect(result.record.candidatePassed).toBe(false);
    expect(result.record.fullPathSucceeded).toBe(false);
    expect(evaluateSuite(manifest, [result.record]).acceptancePassed).toBe(
      false,
    );
    expect(await readFile(result.eventsPath, "utf8")).not.toContain(
      '"applied":true',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
