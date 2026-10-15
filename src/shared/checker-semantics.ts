/** One executable source of truth for workflow/1 vectors and their descriptions. */
export const workflowTextSemantics = {
  normalization: "trim",
  lengthMetric: "unicode-code-point",
  unit: "Unicode 码点",
} as const;
export const workflowTextVector = (count: number, boundary = false) =>
  (boundary ? "🙂" : "字").repeat(count);
