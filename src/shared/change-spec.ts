import type {
  InvestigatedPlan,
  PlanEvidence,
  RequirementReview,
} from "./assistant.js";

/** Shared by host delivery and capability documentation; these are material identities, not tools. */
export const generationMaterialRefs = {
  source: "active-source",
  contract: "candidate-contract",
  scaffold: "candidate-scaffold",
} as const;

export type ChangeDefinition = Pick<
  InvestigatedPlan,
  | "semanticState"
  | "requirements"
  | "browserCases"
  | "workflowRules"
  | "cases"
  | "memberCases"
  | "extensions"
  | "memberAdditions"
  | "memberUpgrades"
  | "memberEnabled"
  | "writableScope"
  | "capabilityChanges"
  | "requiredCapabilities"
  | "binding"
  | "acceptanceChanges"
  | "affectedAcceptance"
  | "excluded"
  | "compatibility"
  | "summary"
  | "changes"
  | "outcome"
  | "dataImpact"
  | "steps"
  | "dependencies"
  | "rollback"
  | "preview"
  | "application"
  | "restartImpact"
  | "intent"
>;

/** Host compiled authority. InvestigatedPlan's flat fields are checked projections. */
export type ChangeSpec = {
  version: "change/3";
  runId: string;
  requestRevision: number;
  baseVersion: string;
  compositionRevision: number;
  baseHash: string;
  definition: ChangeDefinition;
  workflowDefinition?: import("../server/business/contracts.js").WorkflowDefinition;
  requirementOrigins: {
    id: string;
    origin: "request" | "clarification" | "inherited";
    sourceRevision: string;
  }[];
  choices: { field: string; origin: "implementation"; value: unknown }[];
  invariants: { id: string; origin: "host"; contract: string }[];
  validationOrigins: import("../evolution/validation-origins.js").ValidationOrigin[];
  hostRules: import("../evolution/checker-rules.js").HostCheckerRule[];
  hostFacts: import("../evolution/technical-facts.js").TechnicalFact[];
  materials: PlanEvidence[];
};

export type InvestigationState = {
  version: 2;
  baseVersion: string;
  materials: PlanEvidence[];
  deliveries: {
    phase: "planning" | "generation";
    call: number;
    materials: PlanEvidence[];
  }[];
};

export type ReviewFinding = {
  evidenceHash?: string;
  id: string;
  key: string;
  status: "open" | "resolved" | "conflicting";
  revision: number;
  definitionHash: string;
  issue: RequirementReview["issues"][number];
};
export type ReviewLedger = {
  version: 2;
  findings: ReviewFinding[];
  attempts: {
    revision: number;
    definitionHash: string;
    review: RequirementReview;
  }[];
};

export type CandidateDelta = {
  files: { path: string; content: string | null }[];
  members: { pluginId: string; source: string }[];
};
