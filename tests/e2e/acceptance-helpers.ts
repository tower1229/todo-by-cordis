import { expect, type Page } from "@playwright/test";
import type {
  ModelDriver,
  ModelDriverReply,
} from "../../src/evolution/loop.js";

export interface EvolutionStepPlan {
  readonly prompt: string;
  readonly stageArgs: Record<string, unknown>;
  readonly summary: string;
  readonly highlights: readonly string[];
}

export function createStepStubDriver(
  steps: readonly EvolutionStepPlan[],
  prefix: string,
): ModelDriver {
  let stepIndex = 0;
  let phase: "stage" | "present" = "stage";

  return {
    async generate(): Promise<ModelDriverReply> {
      const plan = steps[stepIndex];
      if (!plan) {
        throw new Error(`Unexpected extra model call at step ${stepIndex}`);
      }
      if (phase === "stage") {
        phase = "present";
        return {
          calls: [
            {
              id: `${prefix}-${stepIndex}-stage`,
              name: "stage_plugin_changes",
              args: plan.stageArgs,
            },
            {
              id: `${prefix}-${stepIndex}-verify`,
              name: "verify_candidate",
              args: {},
            },
          ],
          raw: {
            role: "assistant",
            content: `stage ${prefix} ${stepIndex + 1}`,
          },
          usage: { totalTokens: 60 },
        };
      }
      phase = "stage";
      stepIndex += 1;
      return {
        calls: [
          {
            id: `${prefix}-${stepIndex}-present`,
            name: "present_preview",
            args: {
              summary: plan.summary,
              highlights: [...plan.highlights],
            },
          },
        ],
        raw: { role: "assistant", content: `present ${prefix} ${stepIndex}` },
        usage: { totalTokens: 30 },
      };
    },
  };
}

export async function executeEvolutionStepInBrowser(
  page: Page,
  productionUrl: string,
  prompt: string,
  expectedSummary: string,
  onPreviewReady?: () => Promise<void>,
  onPreviewDrawerOpen?: () => Promise<void>,
): Promise<void> {
  await page.getByRole("button", { name: "组合状态" }).click();
  await expect(page.locator("[data-evolution-panel]")).toBeVisible();
  await page.locator("[data-evolution-prompt-input]").fill(prompt);
  await page.locator("[data-evolution-submit-btn]").click();

  await expect(page.locator("[data-evolution-preview-ready]")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("[data-evolution-preview-ready]")).toContainText(
    expectedSummary,
  );
  if (onPreviewReady) {
    await onPreviewReady();
  }

  await page.locator("[data-evolution-open-preview-btn]").click();
  await expect(page.locator("[data-supervisor-preview-banner]")).toBeVisible({
    timeout: 30_000,
  });

  await page.getByRole("button", { name: "组合状态" }).click();
  if (onPreviewDrawerOpen) {
    await onPreviewDrawerOpen();
  }
  await page.locator("[data-evolution-apply-btn]").click();
  await page.waitForURL(`${productionUrl}/`, { timeout: 30_000 });
}
