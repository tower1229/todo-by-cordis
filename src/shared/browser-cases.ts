/** Data interpreted by the trusted host; never executable model code or selectors. */
export type BrowserStep =
  | { kind: "open" | "refresh" | "restart" }
  | { kind: "edit"; title?: string; description?: string }
  | {
      kind: "action";
      member: string;
      action: string;
      input?: Record<string, string>;
    }
  | {
      kind: "field";
      member: string;
      contribution?: string;
      field: string;
      value: string;
      visible?: boolean;
    }
  | {
      kind: "action-visible";
      member: string;
      contribution?: string;
      action: string;
      visible: boolean;
    }
  | { kind: "error"; text: string }
  | { kind: "task"; title?: string; description?: string };
export type BrowserCase = {
  id: string;
  task: "existing" | "new";
  steps: BrowserStep[];
  prepare?: import("./acceptance-obligations.js").BaselinePreparation;
  obligationId?: string;
  classification?: "frozen-business" | "system-protection";
};
export type BrowserCaseResult = {
  caseId: string;
  requirementIds: string[];
  viewport: { width: number; height: number };
  status: "passed" | "failed";
  expected?: BrowserStep;
  actual?: string;
  diagnostic?: string;
  screenshot?: string;
  phase?: "preparation" | "candidate";
  obligationId?: string;
  classification?: "frozen-business" | "system-protection";
};
export type BrowserEvidence = {
  checker: "browser/1";
  checkerHash: string;
  browserVersion?: string;
  candidateVersion: string;
  baseVersion: string;
  candidateProgramHash: string;
  definitionHash: string;
  frontendHash: string;
  fixtureHash: string;
  directory: string;
  results: BrowserCaseResult[];
  preparations?: {
    caseId: string;
    viewport: { width: number; height: number };
    sourceHash: string;
    baseVersion: string;
    expected: { state: string; fields: Record<string, string> };
    actual: { state: string; fields: Record<string, string> };
    status: "passed" | "failed";
    screenshot?: string;
    diagnostic?: string;
  }[];
};
