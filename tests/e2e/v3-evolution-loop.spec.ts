import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureV3ClientAssets } from "../../src/v3/client-bundle-builder.js";
import { CompositionRelease } from "../../src/v3/composition-release.js";
import {
  EvolutionLoop,
  type ModelDriver,
  type ModelDriverReply,
} from "../../src/v3/evolution-loop.js";
import { startV3HttpServer } from "../../src/v3/http-gateway.js";
import { buildPluginPackage } from "../../src/v3/plugin-builder.js";
import type { VerificationReport } from "../../src/v3/plugin-verifier.js";
import type { CompositionSnapshot } from "../../src/v3/types.js";

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

async function createSeedPlugin() {
  return await buildPluginPackage({
    pluginId: "seed-app",
    name: "Seed App",
    dependencies: [],
    contractTypes: `
export {};
declare module "@host/client-sdk" {
  interface SlotPropsMap {
    "seed.banner": { readonly label: string };
  }
}
`,
    serverSource: `
import { Context } from "cordis";
import "@host/server-sdk";
export const name = "seed-app";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/status", () => ({ ok: true }));
}
`,
    clientSource: `
import type { Context } from "cordis";
import { Slot } from "@host/client-sdk";

export const name = "seed-app";
export function apply(ctx: Context) {
  ctx.router.registerPage({
    path: "/",
    navLabel: "首页",
    component: function HomePage() {
      return (
        <div className="p-4">
          <h1 data-seed-title="true" className="text-base font-semibold">Seed App</h1>
          <Slot name="seed.banner" props={{ label: "main" }} />
        </div>
      );
    },
  });
}
`,
  });
}

test.describe("V3 EvolutionLoop E2E (real Chromium + SupervisorShell)", () => {
  test("drives direct-to-preview, in-preview refinement hot-refresh, and apply via SupervisorShell sidebar", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "v3-evo-e2e-"));
    const assetsDir = await ensureV3ClientAssets();
    const release = new CompositionRelease({
      controlDbPath: join(dir, "supervisor.db"),
      businessDbPath: join(dir, "app.db"),
      workDir: join(dir, "work"),
      clientAssetsDir: assetsDir,
      enablePreviewClientHost: true,
    });

    const seed = await createSeedPlugin();
    const initComp: CompositionSnapshot = {
      compositionId: "comp-e2e-init",
      parentCompositionId: null,
      members: [
        { pluginId: seed.pluginId, versionId: seed.versionId, enabled: true },
      ],
      createdAt: new Date().toISOString(),
    };
    await release.bootstrap({ composition: initComp, artifacts: [seed] });

    let step = 0;
    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        step += 1;
        if (step === 1) {
          return {
            calls: [
              {
                id: "e1",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "banner-badge",
                      name: "Banner Badge",
                      dependencies: ["seed-app"],
                      contractTypes: "",
                      sourceFiles: {
                        "client.tsx": `
import type { Context } from "cordis";
import "@host/client-sdk";
export const name = "banner-badge";
export function apply(ctx: Context) {
  ctx.slots.register("seed.banner", () => (
    <div data-banner-badge="v1" className="mt-2 text-xs text-accent">Badge V1</div>
  ));
}
`,
                      },
                      testFiles: {},
                    },
                  ],
                },
              },
              { id: "e2", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "stage v1" },
            usage: { totalTokens: 80 },
          };
        }
        if (step === 2) {
          return {
            calls: [
              {
                id: "e3",
                name: "present_preview",
                args: {
                  summary: "新增 Banner Badge V1",
                  highlights: ["在 seed.banner 插槽展示 Badge V1"],
                },
              },
            ],
            raw: { role: "assistant", content: "preview v1" },
            usage: { totalTokens: 40 },
          };
        }
        if (step === 3) {
          return {
            calls: [
              {
                id: "e4",
                name: "stage_plugin_changes",
                args: {
                  upserts: [
                    {
                      pluginId: "banner-badge",
                      name: "Banner Badge",
                      dependencies: ["seed-app"],
                      contractTypes: "",
                      sourceFiles: {
                        "client.tsx": `
import type { Context } from "cordis";
import "@host/client-sdk";
export const name = "banner-badge";
export function apply(ctx: Context) {
  ctx.slots.register("seed.banner", () => (
    <div data-banner-badge="v2" className="mt-2 text-xs text-accent">Badge V2 Refined</div>
  ));
}
`,
                      },
                      testFiles: {},
                    },
                  ],
                },
              },
              { id: "e5", name: "verify_candidate", args: {} },
            ],
            raw: { role: "assistant", content: "stage v2" },
            usage: { totalTokens: 80 },
          };
        }
        return {
          calls: [
            {
              id: "e6",
              name: "present_preview",
              args: {
                summary: "微调 Banner Badge 为 V2",
                highlights: ["文案更新为 Badge V2 Refined"],
              },
            },
          ],
          raw: { role: "assistant", content: "preview v2" },
          usage: { totalTokens: 40 },
        };
      },
    };

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
      verifyFn: async () => makePassingReport(["seed-app", "banner-badge"]),
    });
    release.setEvolutionController(loop);

    const server = await startV3HttpServer(release.runtime, {
      clientAssetsDir: assetsDir,
      enableClientHost: true,
      releaseController: release,
      evolutionController: loop,
    });
    release.setProductionUrl(server.url);

    try {
      await page.goto(server.url);
      await expect(page.locator("[data-seed-title]")).toHaveText("Seed App");

      // Open SupervisorShell drawer
      await page.getByRole("button", { name: "组合状态" }).click();
      await expect(page.locator("[data-evolution-panel]")).toBeVisible();

      // Submit natural language requirement directly (no pre-execution confirmation)
      await page
        .locator("[data-evolution-prompt-input]")
        .fill("在首页横幅插槽增加一个 Badge V1");
      await page.locator("[data-evolution-submit-btn]").click();

      // Wait for preview_ready in sidebar
      await expect(page.locator("[data-evolution-preview-ready]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("[data-evolution-preview-ready]")).toContainText(
        "新增 Banner Badge V1",
      );

      // Open isolated preview
      await page.locator("[data-evolution-open-preview-btn]").click();
      await expect(page.locator("[data-supervisor-preview-banner]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('[data-banner-badge="v1"]')).toHaveText(
        "Badge V1",
      );

      // Open drawer inside preview and send incremental refinement
      await page.getByRole("button", { name: "组合状态" }).click();
      await page
        .locator("[data-evolution-refine-input]")
        .fill("把文案改为 Badge V2 Refined");
      await page.locator("[data-evolution-refine-submit]").click();

      // Preview hot-refreshes in-place without page reload!
      await expect(page.locator('[data-banner-badge="v2"]')).toHaveText(
        "Badge V2 Refined",
        { timeout: 15_000 },
      );

      // Confirm apply from sidebar
      await page.locator("[data-evolution-apply-btn]").click();
      await page.waitForURL(`${server.url}/`, { timeout: 15_000 });
      await expect(page.locator('[data-banner-badge="v2"]')).toHaveText(
        "Badge V2 Refined",
        { timeout: 15_000 },
      );
    } finally {
      await loop.close();
      await server.close();
      await release.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles clarification pause/resume and budget exhaustion/extension in SupervisorShell sidebar", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "v3-evo-e2e-flows-"));
    const assetsDir = await ensureV3ClientAssets();
    const release = new CompositionRelease({
      controlDbPath: join(dir, "supervisor.db"),
      businessDbPath: join(dir, "app.db"),
      workDir: join(dir, "work"),
      clientAssetsDir: assetsDir,
      enablePreviewClientHost: true,
    });

    const seed = await createSeedPlugin();
    const initComp: CompositionSnapshot = {
      compositionId: "comp-e2e-init-2",
      parentCompositionId: null,
      members: [
        { pluginId: seed.pluginId, versionId: seed.versionId, enabled: true },
      ],
      createdAt: new Date().toISOString(),
    };
    await release.bootstrap({ composition: initComp, artifacts: [seed] });

    let step = 0;
    const stubDriver: ModelDriver = {
      async generate(): Promise<ModelDriverReply> {
        step += 1;
        if (step === 1) {
          return {
            calls: [
              {
                id: "q1",
                name: "clarify_request",
                args: {
                  question: "是否保留历史记录？",
                  options: ["保留历史", "直接清空"],
                },
              },
            ],
            raw: { role: "assistant", content: "clarify" },
            usage: { totalTokens: 40 },
          };
        }
        if (step === 2) {
          return {
            calls: [
              {
                id: "s1",
                name: "stage_plugin_changes",
                args: {
                  toggles: [{ pluginId: "seed-app", enabled: true }],
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
              args: { summary: "保留历史方案预览就绪" },
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
      defaultBudget: { callLimit: 2, activeMsLimit: 60_000 },
      verifyFn: async () => makePassingReport(["seed-app"]),
    });
    release.setEvolutionController(loop);

    const server = await startV3HttpServer(release.runtime, {
      clientAssetsDir: assetsDir,
      enableClientHost: true,
      releaseController: release,
      evolutionController: loop,
    });
    release.setProductionUrl(server.url);

    try {
      await page.goto(server.url);
      await page.getByRole("button", { name: "组合状态" }).click();

      await page.locator("[data-evolution-prompt-input]").fill("清理旧数据");
      await page.locator("[data-evolution-submit-btn]").click();

      // Clarification pause
      await expect(page.locator("[data-evolution-clarification]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("[data-evolution-clarification]")).toContainText(
        "需要你选择",
      );
      await page
        .locator('[data-evolution-clarify-option="保留历史"]')
        .click();

      // After 2nd call, budget (callLimit=2) is exhausted -> awaiting_budget & prompt input hidden
      await expect(page.locator("[data-evolution-budget-paused]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("[data-evolution-prompt-input]")).toHaveCount(0);

      // Click "继续进行" to extend budget and resume
      await page.locator("[data-evolution-extend-budget-btn]").click();
      await expect(page.locator("[data-evolution-preview-ready]")).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator("[data-evolution-preview-ready]")).toContainText(
        "尚未应用",
      );
    } finally {
      await loop.close();
      await server.close();
      await release.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
