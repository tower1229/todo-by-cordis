import { currentManifest } from "./current.js";
import type { StabilityEvalManifest } from "./manifest.js";

/** A new diagnostic identity; never rewrite the historical fixed-budget manifest. */
export function extendedTimeManifest(productCommit: string): StabilityEvalManifest {
  const original = currentManifest(productCommit);
  return {
    ...original,
    resourceProfile: "extended-time/1",
    budget: { ...original.budget, milliseconds: 1_800_000 },
  };
}
