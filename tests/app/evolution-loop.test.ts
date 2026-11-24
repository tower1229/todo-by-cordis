import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDeepSeekDriver } from "../../src/evolution/model/deepseek.js";
import { CompositionRelease } from "../../src/release/composition-release.js";
import {
  EVOLUTION_TOOLS,
  EvolutionLoop,
  type ModelDriver,
  type ModelDriverReply,
  type ModelDriverRequest,
  UNKNOWN_USAGE_CONSERVATIVE_TOKENS,
} from "../../src/evolution/loop.js";
import { buildPluginPackage } from "../../src/build/plugin-builder.js";
import type { VerificationReport } from "../../src/verify/index.js";
import type { CompositionSnapshot } from "../../src/contracts/types.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createSeedRelease(dir: string) {
  const release = new CompositionRelease({
    controlDbPath: join(dir, "supervisor.db"),
    businessDbPath: join(dir, "app.db"),
    workDir: join(dir, "work"),
    enablePreviewClientHost: false,
  });

  const baseArtifact = await buildPluginPackage({
    pluginId: "core-notes",
    name: "Core Notes",
    dependencies: [],
    contractTypes: `
export interface NoteService {
  ping(): string;
}
declare module "cordis" {
  interface Context {
    notes: NoteService;
  }
  interface Events {
    "notes:created"(id: string): void;
  }
}
declare module "@host/client-sdk" {
  interface SlotPropsMap {
    "notes.header": { readonly title: string };
  }
}
`,
    sourceFiles: {
      "server.ts": `
import { Context } from "cordis";
import "@host/server-sdk";
export const name = "core-notes";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/ping", () => ({ ok: true, plugin: "core-notes" }));
}
`,
    },
    testFiles: {
      "core.spec.ts": `export default async function () {}`,
    },
  });

  const initialComp: CompositionSnapshot = {
    compositionId: "comp-init-1",
    parentCompositionId: null,
    members: [
      {
        pluginId: baseArtifact.pluginId,
        versionId: baseArtifact.versionId,
        enabled: true,
      },
    ],
    createdAt: new Date().toISOString(),
  };

  await release.bootstrap({
    composition: initialComp,
    artifacts: [baseArtifact],
  });

  return { release, baseArtifact, initialComp };
}

function makePassingReport(probedPlugins: string[]): VerificationReport {
  return {
    ok: true,
    errors: [],
    staticViolations: [],
    dagViolations: [],
    probedPlugins,
    ablationResults: [],
    testChangeDisclosures: [],
    warnings: [],
    noBehaviorDiffWarning: false,
  };
}

describe("EvolutionLoop (5-tool state machine)", () => {
  it("delivers single compact topology context, self-fixes build error, rejects unverified present_preview, refines in preview with hot-refresh, and applies", async () => {
    const dir = createTempDir("host-evo-flow-");
    const { release } = await createSeedRelease(dir);

    const observedRequests: ModelDriverRequest[] = [];
    let step = 0;

    const stubDriver: ModelDriver = {
      async generate(req): Promise<ModelDriverReply> {
        observedRequests.push(req);
        step += 1;

        // Step 1: Attempt present_preview BEFORE verifying -> must be rejected by host
        if (step === 1) {
          return {
            calls: [
              {
                id: "c1",
                name: "present_preview",
                args: { summary: "未验证偷跑" },
              },
            ],
            raw: { role: "assistant", content: "try bypass" },
            usage: { unknown: true },
          };
        }

        // Step 2: Stage broken TypeScript plugin + verify_candidate -> build error returned
        if (step === 2) {
          return {
            calls: [
              {
                id: "c2",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "greeting",
                      name: "Greeting",
                      dependencies: ["core-notes"],
                      contractTypes: "",
                      sourceFiles: {
                        "server.ts": `
import { Context } from "cordis";
import "@host/server-sdk";
export const name = "greeting";
export function apply(ctx: Context) {
  const broken: number = "not-a-number";
  ctx.http.route("GET", "/hello", () => ({ msg: broken }));
}
`,
                      },
                      testFiles: {},
                    },
                  ],
                },
              },
              { id: "c3", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "stage broken" },
            usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          };
        }

        // Step 3: Fix TypeScript error, verify_candidate -> passes!
        if (step === 3) {
          return {
            calls: [
              {
                id: "c4",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "greeting",
                      name: "Greeting",
                      dependencies: ["core-notes"],
                      contractTypes: "",
                      sourceFiles: {
                        "server.ts": `
import { Context } from "cordis";
import "@host/server-sdk";
export const name = "greeting";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/hello", () => ({ msg: "hello-v1" }));
}
`,
                      },
                      testFiles: {},
                    },
                  ],
                },
              },
              { id: "c5", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "fix and verify" },
            usage: { totalTokens: 120 },
          };
        }

        // Step 4: present_preview -> enters preview_ready
        if (step === 4) {
          return {
            calls: [
              {
                id: "c6",
                name: "present_preview",
                args: {
                  summary: "新增 greeting 插件 v1",
                  highlights: ["提供 /api/app/greeting/hello 接口"],
                },
              },
            ],
            raw: { role: "assistant", content: "present v1" },
            usage: { totalTokens: 80 },
          };
        }

        // Step 5 (continueInPreview): update greeting to v2, verify, present_preview -> hot-refresh!
        if (step === 5) {
          return {
            calls: [
              {
                id: "c7",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "greeting",
                      name: "Greeting",
                      dependencies: ["core-notes"],
                      contractTypes: "",
                      sourceFiles: {
                        "server.ts": `
import { Context } from "cordis";
import "@host/server-sdk";
export const name = "greeting";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/hello", () => ({ msg: "hello-v2-refined" }));
}
`,
                      },
                      testFiles: {},
                    },
                  ],
                },
              },
              { id: "c8", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "refine v2" },
            usage: { totalTokens: 110 },
          };
        }

        return {
          calls: [
            {
              id: "c9",
              name: "present_preview",
              args: {
                summary: "微调 greeting 插件为 v2",
                highlights: ["响应升级为 hello-v2-refined"],
              },
            },
          ],
          raw: { role: "assistant", content: "present v2" },
          usage: { totalTokens: 70 },
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      verifyFn: async () => makePassingReport(["core-notes", "greeting"]),
    });

    try {
      const started = await loop.startRun("新增一个 greeting 插件");
      assert.equal(started.status, "running");

      const previewReady = await loop.waitForRun(started.runId);
      assert.equal(previewReady.status, "preview_ready");
      assert.ok(previewReady.previewUrl);
      assert.ok(previewReady.previewSessionId);
      assert.equal(previewReady.budget.unknownUsageCount, 1);
      assert.ok(
        previewReady.budget.estimatedTokens >= UNKNOWN_USAGE_CONSERVATIVE_TOKENS,
      );

      // Verify initial context contained topology, contractTypes, slots, events, and strictly 5 tools
      assert.equal(observedRequests[0]!.tools.length, 5);
      assert.deepEqual(
        observedRequests[0]!.tools.map((t) => t.name),
        EVOLUTION_TOOLS.map((t) => t.name),
      );
      const initialMsg = JSON.stringify(observedRequests[0]!.history[0]);
      assert.ok(initialMsg.includes("core-notes"));
      assert.ok(initialMsg.includes("notes.header"));
      assert.ok(initialMsg.includes("notes:created"));

      // Verify isolated preview responds with v1
      const v1Res = await fetch(`${previewReady.previewUrl}/api/app/greeting/hello`);
      assert.equal(v1Res.status, 200);
      assert.deepEqual(await v1Res.json(), { msg: "hello-v1" });

      // Continue in preview -> hot-refreshes the SAME preview session!
      const originalSessionId = previewReady.previewSessionId;
      await loop.continueInPreview(started.runId, "把返回内容改为 hello-v2-refined");
      const refined = await loop.waitForRun(started.runId);
      assert.equal(refined.status, "preview_ready");
      assert.equal(refined.previewSessionId, originalSessionId);

      const v2Res = await fetch(`${refined.previewUrl}/api/app/greeting/hello`);
      assert.equal(v2Res.status, 200);
      assert.deepEqual(await v2Res.json(), { msg: "hello-v2-refined" });

      // Apply candidate -> production runtime gets greeting v2
      const applied = await loop.applyRun(started.runId);
      assert.ok(applied.composition.members.some((m) => m.pluginId === "greeting"));
      const finalRun = loop.getRun(started.runId);
      assert.equal(finalRun?.status, "applied");

      const prodResp = await release.runtime.handleHttpRequest({
        method: "GET",
        path: "/api/app/greeting/hello",
      });
      assert.equal(prodResp.status, 200);
      assert.deepEqual(prodResp.body, { msg: "hello-v2-refined" });
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("pauses on clarify_request and resumes the same run after user answers", async () => {
    const dir = createTempDir("host-evo-clarify-");
    const { release } = await createSeedRelease(dir);

    let step = 0;
    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        step += 1;
        if (step === 1) {
          return {
            calls: [
              {
                id: "clarify-1",
                name: "clarify_request",
                args: {
                  question: "清空数据时是仅归档还是永久删除？",
                  options: ["仅归档", "永久删除"],
                },
              },
            ],
            raw: { role: "assistant", content: "ask clarify" },
            usage: { totalTokens: 60 },
          };
        }
        if (step === 2) {
          return {
            calls: [
              {
                id: "s1",
                name: "stage_plugin_changes",
                args: {
                  toggles: [{ pluginId: "core-notes", enabled: true }],
                },
              },
              { id: "v1", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "stage and verify" },
            usage: { totalTokens: 60 },
          };
        }
        return {
          calls: [
            {
              id: "p1",
              name: "present_preview",
              args: { summary: "按归档方案完成配置" },
            },
          ],
          raw: { role: "assistant", content: "preview" },
          usage: { totalTokens: 40 },
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const run = await loop.startRun("帮我加一个清理按钮");
      const paused = await loop.waitForRun(run.runId);
      assert.equal(paused.status, "awaiting_clarification");
      assert.equal(
        paused.clarification?.question,
        "清空数据时是仅归档还是永久删除？",
      );

      await loop.answerClarification(run.runId, "仅归档");
      const done = await loop.waitForRun(run.runId);
      assert.equal(done.status, "preview_ready");
      assert.equal(done.runId, run.runId);
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("pauses on budget exhaustion without resetting ledger or workspace, and resumes when user extends budget", async () => {
    const dir = createTempDir("host-evo-budget-");
    const { release } = await createSeedRelease(dir);

    let step = 0;
    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        step += 1;
        if (step === 1) {
          return {
            calls: [
              {
                id: "s1",
                name: "stage_plugin_changes",
                args: {
                  toggles: [{ pluginId: "core-notes", enabled: true }],
                },
              },
              { id: "v1", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "step 1" },
            usage: { totalTokens: 50 },
          };
        }
        return {
          calls: [
            {
              id: "p1",
              name: "present_preview",
              args: { summary: "预算追加后进入预览" },
            },
          ],
          raw: { role: "assistant", content: "step 2" },
          usage: { totalTokens: 50 },
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      defaultBudget: { callLimit: 1, activeMsLimit: 60_000 },
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const run = await loop.startRun("测试预算耗尽与追加");
      const paused = await loop.waitForRun(run.runId);
      assert.equal(paused.status, "awaiting_budget");
      assert.equal(paused.budget.callsUsed, 1);
      assert.equal(paused.budget.callLimit, 1);

      await loop.extendBudget(run.runId, { additionalCalls: 2 });
      const resumed = await loop.waitForRun(run.runId);
      assert.equal(resumed.status, "preview_ready");
      // Historical callsUsed is preserved (1 + 1 = 2), NOT reset to 0!
      assert.equal(resumed.budget.callsUsed, 2);
      assert.equal(resumed.budget.callLimit, 3);
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("marks unfinished running runs interrupted on restart without calling model, and restores preview_ready runs from persisted artifacts", async () => {
    const dir = createTempDir("host-evo-restart-");
    const { release } = await createSeedRelease(dir);

    let modelCallsAfterRestart = 0;
    let step = 0;
    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        step += 1;
        if (step === 1) {
          return {
            calls: [
              {
                id: "s1",
                name: "stage_plugin_changes",
                args: {
                  toggles: [{ pluginId: "core-notes", enabled: true }],
                },
              },
              { id: "v1", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "stage" },
            usage: { totalTokens: 40 },
          };
        }
        return {
          calls: [
            {
              id: "p1",
              name: "present_preview",
              args: { summary: "可恢复预览的候选" },
            },
          ],
          raw: { role: "assistant", content: "preview" },
          usage: { totalTokens: 40 },
        };
      },
    };

    const loop1 = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    const readyRun = await loop1.startRun("准备可恢复的预览");
    await loop1.waitForRun(readyRun.runId);

    // Simulate a crashed in-flight running run persisted in ControlStore
    const existing = release.controlStore.getEvolutionRun(readyRun.runId)!;
    release.controlStore.saveEvolutionRun({
      ...existing,
      runId: "evo-crashed-1",
      status: "running",
      stage: "calling_model",
      candidateId: null,
      previewSessionId: null,
      previewUrl: null,
    });

    await loop1.close();
    await release.close();

    // Reopen after simulated server restart
    const release2 = new CompositionRelease({
      controlDbPath: join(dir, "supervisor.db"),
      businessDbPath: join(dir, "app.db"),
      workDir: join(dir, "work"),
      enablePreviewClientHost: false,
    });
    await release2.bootstrap();

    const loop2 = new EvolutionLoop({
      release: release2,
      modelDriver: {
        async generate() {
          modelCallsAfterRestart += 1;
          throw new Error("Should never auto-call model on restart!");
        },
      },
    });

    try {
      const interruptedCount = loop2.recoverOnStartup();
      assert.equal(interruptedCount, 1);
      assert.equal(modelCallsAfterRestart, 0);

      const crashed = loop2.getRun("evo-crashed-1");
      assert.equal(crashed?.status, "interrupted");

      const restored = await loop2.restorePreview(readyRun.runId);
      assert.ok(restored.previewUrl);
      assert.equal(modelCallsAfterRestart, 0);

      const applyRes = await loop2.applyRun(readyRun.runId);
      assert.ok(applyRes.composition.compositionId);
      assert.equal(loop2.getRun(readyRun.runId)?.status, "applied");
    } finally {
      await loop2.close();
      await release2.close();
    }
  });

  it("cancels an in-flight run without executeLoop overwriting cancelled status", async () => {
    const dir = createTempDir("host-evo-cancel-");
    const { release } = await createSeedRelease(dir);

    let resolveModel!: (reply: ModelDriverReply) => void;
    const modelPromise = new Promise<ModelDriverReply>((resolve) => {
      resolveModel = resolve;
    });

    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        return await modelPromise;
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const started = await loop.startRun("测试取消在途运行");
      const cancelled = await loop.cancelRun(started.runId);
      assert.equal(cancelled.status, "cancelled");

      // Even if the in-flight model promise resolves afterward, status must stay cancelled
      resolveModel({
        calls: [
          {
            id: "late-1",
            name: "stage_plugin_changes",
            args: { toggles: [{ pluginId: "core-notes", enabled: true }] },
          },
        ],
        raw: { role: "assistant", content: "late reply" },
        usage: { totalTokens: 50 },
      });

      const settled = await loop.waitForRun(started.runId);
      assert.equal(settled.status, "cancelled");
      assert.equal(loop.getRun(started.runId)?.status, "cancelled");
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("createDeepSeekModelDriver records valid assistant messages across multi-turn tool calls and feeds back protocolErrors without executing invalid tools", async () => {
    const dir = createTempDir("host-evo-deepseek-adapter-");
    const { release } = await createSeedRelease(dir);

    const outboundBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
    let httpTurn = 0;

    const fakeFetch: typeof fetch = async (_input, init) => {
      httpTurn += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<Record<string, unknown>>;
      };
      outboundBodies.push(body);

      let responsePayload: Record<string, unknown>;
      if (httpTurn === 1) {
        // Turn 1: malformed JSON arguments -> DeepSeek emits protocolErrors
        responsePayload = {
          id: "chatcmpl-1",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "first attempt",
                tool_calls: [
                  {
                    id: "call_bad_1",
                    type: "function",
                    function: {
                      name: "stage_plugin_changes",
                      arguments: '{"upserts":[{"pluginId":"todo-core"}]}}',
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        };
      } else if (httpTurn === 2) {
        // Turn 2: valid inspect_plugin tool call
        responsePayload = {
          id: "chatcmpl-2",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "inspect core first",
                tool_calls: [
                  {
                    id: "call_inspect_2",
                    type: "function",
                    function: {
                      name: "inspect_plugin",
                      arguments: JSON.stringify({ pluginId: "core-notes" }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 25, total_tokens: 175 },
        };
      } else {
        // Turn 3: clarify_request to finish cleanly
        responsePayload = {
          id: "chatcmpl-3",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_clarify_3",
                    type: "function",
                    function: {
                      name: "clarify_request",
                      arguments: JSON.stringify({
                        question: "确认是否保留历史记录？",
                        options: ["保留", "清空"],
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 },
        };
      }

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const driver = createDeepSeekDriver({ apiKey: "test-key", http: fakeFetch });

    const loop = new EvolutionLoop({
      release,
      modelDriver: driver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const started = await loop.startRun("测试 DeepSeek 多轮协议兼容");
      const finished = await loop.waitForRun(started.runId);
      assert.equal(finished.status, "awaiting_clarification");
      assert.equal(httpTurn, 3);

      // Every outbound message on turns 2 and 3 must have a valid role (never raw HTTP envelope)
      for (const reqBody of outboundBodies) {
        for (const msg of reqBody.messages) {
          assert.equal(typeof msg.role, "string");
          assert.equal("choices" in msg, false);
        }
      }

      // Turn 2 must carry assistant message with reasoning_content + tool error receipt for call_bad_1
      const turn2Msgs = outboundBodies[1]!.messages;
      const turn2Assistant = turn2Msgs.find((m) => m.role === "assistant");
      assert.ok(turn2Assistant);
      assert.equal(turn2Assistant.reasoning_content, "first attempt");
      const turn2Tool = turn2Msgs.find(
        (m) => m.role === "tool" && m.tool_call_id === "call_bad_1",
      );
      assert.ok(turn2Tool);
      assert.match(String(turn2Tool.content), /protocolErrors/);
      assert.match(String(turn2Tool.content), /near:/);
      assert.match(String(turn2Tool.content), /todo-core/);

      // Turn 3 must carry inspect_plugin tool receipt for call_inspect_2
      const turn3Tool = outboundBodies[2]!.messages.find(
        (m) => m.role === "tool" && m.tool_call_id === "call_inspect_2",
      );
      assert.ok(turn3Tool);
      assert.match(String(turn3Tool.content), /core-notes/);
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("stage_plugin_changes rejects no-op payloads and incrementally merges partial updates with staged and baseline packages", async () => {
    const dir = createTempDir("host-evo-stage-merge-");
    const { release } = await createSeedRelease(dir);

    let turn = 0;

    const driver: ModelDriver = {
      async generate() {
        turn += 1;

        if (turn === 1) {
          // Malformed nesting: wrapped inside `arguments` instead of top-level `upserts`/`toggles`
          return {
            calls: [
              {
                id: "call_noop",
                name: "stage_plugin_changes",
                args: {
                  arguments: {
                    upserts: [{ pluginId: "core-notes", contractTypes: "export {};" }],
                  },
                },
              },
            ],
          };
        }
        if (turn === 2) {
          // Partial update 1: only contractTypes on baseline plugin `core-notes`
          return {
            calls: [
              {
                id: "call_part_1",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "core-notes",
                      contractTypes: "export interface CoreNotesService { version: 2; }\n",
                    },
                  ],
                },
              },
            ],
          };
        }
        if (turn === 3) {
          // Partial update 2: only server.ts on already-staged `core-notes`
          return {
            calls: [
              {
                id: "call_part_2",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "core-notes",
                      sourceFiles: {
                        "server.ts": "export const name = 'core-notes';\nexport function apply() {}\n",
                      },
                    },
                  ],
                },
              },
            ],
          };
        }
        return {
          calls: [
            {
              id: "call_done",
              name: "clarify_request",
              args: { question: "done" },
            },
          ],
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: driver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const started = await loop.startRun("测试增量 stage 与空操作拦截");
      const finished = await loop.waitForRun(started.runId);
      assert.equal(finished.status, "awaiting_clarification", finished.error ?? "no error");

      const persisted = release.controlStore.getEvolutionRun(started.runId);
      assert.ok(persisted);

      const findToolReceipt = (callId: string): Record<string, unknown> => {
        for (const msg of persisted.messages) {
          if (!msg || typeof msg !== "object") continue;
          const parts = (msg as { parts?: unknown[] }).parts;
          if (!Array.isArray(parts)) continue;
          for (const part of parts) {
            const fr = (part as { functionResponse?: { id?: string; response?: Record<string, unknown> } })
              ?.functionResponse;
            if (fr?.id === callId && fr.response) {
              return fr.response;
            }
          }
        }
        assert.fail(`expected tool receipt for ${callId}`);
      };

      // Turn 1 tool response must reject no-op payload
      const noopResp = findToolReceipt("call_noop");
      assert.equal(noopResp.ok, false);
      assert.match(String(noopResp.error ?? ""), /upserts|toggles/i);

      // Turn 2 & 3 must succeed and preserve merged fields
      assert.equal(findToolReceipt("call_part_1").ok, true);
      assert.equal(findToolReceipt("call_part_2").ok, true);

      const stagedCore = persisted.stagedWorkspace.upserts["core-notes"];
      assert.ok(stagedCore);
      // Preserved baseline name & testFiles, kept Turn 2 contractTypes, updated Turn 3 server.ts
      assert.equal(stagedCore.name, "Core Notes");
      assert.equal(
        stagedCore.contractTypes,
        "export interface CoreNotesService { version: 2; }\n",
      );
      assert.equal(
        stagedCore.sourceFiles["server.ts"],
        "export const name = 'core-notes';\nexport function apply() {}\n",
      );
      assert.ok(
        Object.keys(stagedCore.testFiles).length > 0,
        "baseline testFiles should be preserved during incremental stage",
      );
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("initial topology context delivers canonical .d.ts hostSdkContracts and system prompt points to it", async () => {
    const dir = createTempDir("host-evo-system-prompt-");
    const { release } = await createSeedRelease(dir);

    let capturedSystem = "";
    let capturedInitialContext = "";
    const driver: ModelDriver = {
      async generate(request) {
        capturedSystem = request.system;
        const firstMsg = request.history[0] as
          | { parts?: Array<{ text?: string }>; content?: string }
          | undefined;
        capturedInitialContext =
          firstMsg?.parts?.[0]?.text ??
          (typeof firstMsg?.content === "string" ? firstMsg.content : "");
        return {
          calls: [
            { id: "call_done", name: "clarify_request", args: { question: "阅读提示" } },
          ],
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: driver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const started = await loop.startRun("读取 hostSdkContracts");
      await loop.waitForRun(started.runId);
      assert.match(capturedSystem, /hostSdkContracts/);
      const parsed = JSON.parse(capturedInitialContext) as {
        hostSdkContracts?: string;
      };
      assert.equal(typeof parsed.hostSdkContracts, "string");
      assert.match(parsed.hostSdkContracts!, /declare module "@host\/client-sdk"/);
      assert.match(parsed.hostSdkContracts!, /declare module "@host\/server-sdk"/);
      assert.match(parsed.hostSdkContracts!, /registerPage\(/);
      assert.match(parsed.hostSdkContracts!, /readonly slots:/);
      assert.match(parsed.hostSdkContracts!, /route\(/);
    } finally {
      await loop.close();
      await release.close();
    }
  });

  it("preserves sibling tool receipts when clarify_request appears in a multi-tool turn and closes preview session on cancelRun", async () => {
    const dir = createTempDir("host-evo-clarify-cancel-");
    const { release } = await createSeedRelease(dir);

    let turn = 0;
    const driver: ModelDriver = {
      async generate() {
        turn += 1;
        if (turn === 1) {
          return {
            calls: [
              { id: "c_inspect", name: "inspect_plugin", args: { pluginId: "core-notes" } },
              { id: "c_clarify", name: "clarify_request", args: { question: "确认范围？" } },
              { id: "c_skipped", name: "verify_candidate", args: {} },
            ],
          };
        }
        if (turn === 2) {
          return {
            calls: [
              {
                id: "c_stage",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "core-notes",
                      contractTypes: "export interface NoteService { ping(): string; }\n",
                    },
                  ],
                },
              },
              { id: "c_verify", name: "verify_candidate", args: {} },
            ],
          };
        }
        return {
          calls: [
            {
              id: "c_preview",
              name: "present_preview",
              args: { summary: "ready", highlights: ["ok"] },
            },
          ],
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: driver,
      verifyFn: async () => makePassingReport(["core-notes"]),
    });

    try {
      const started = await loop.startRun("测试多工具澄清与取消回收预览");
      const paused = await loop.waitForRun(started.runId);
      assert.equal(paused.status, "awaiting_clarification");

      // Both sibling tool_calls (c_inspect and c_skipped) must have receipts persisted
      const persistedPaused = release.controlStore.getEvolutionRun(started.runId)!;
      const receiptIds: string[] = [];
      for (const m of persistedPaused.messages) {
        const parts = (m as { parts?: Array<{ functionResponse?: { id?: string } }> })?.parts;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
          if (p.functionResponse?.id) receiptIds.push(p.functionResponse.id);
        }
      }
      assert.ok(receiptIds.includes("c_inspect"));
      assert.ok(receiptIds.includes("c_skipped"));

      // Resume -> preview_ready -> cancelRun must close preview session and clear preview fields
      await loop.answerClarification(started.runId, "确认");
      const previewReady = await loop.waitForRun(started.runId);
      assert.equal(previewReady.status, "preview_ready");
      assert.ok(previewReady.previewSessionId);

      const cancelled = await loop.cancelRun(started.runId);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.previewSessionId, null);
      assert.equal(cancelled.previewUrl, null);
    } finally {
      await loop.close();
      await release.close();
    }
  });
});
