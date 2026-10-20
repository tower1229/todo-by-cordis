/** Finite business policies. The host owns all time advances and action sequences. */
export const schedulePolicySemantics = {
  "complete-retains-effect":
    "真实调度产生到期效果后完成任务，保留冻结的到期效果",
  "reopen-after-due":
    "截止前完成，到点保持完成且不产生到期效果；过点重新打开后由真实调度补执行",
} as const;
export type SchedulePolicyCheck = keyof typeof schedulePolicySemantics;
export type SchedulePolicy = {
  version: 1;
  id: string;
  kind: "schedule-policy";
  action: { kind: "action"; member: string; action: string };
  fireCase: { caseId: string; definitionHash: string };
  checks: SchedulePolicyCheck[];
};
export function schedulePolicyChecks(policy: SchedulePolicy) {
  return policy.checks.map((check) => ({
    checker: "schedule/1",
    caseId: `schedule-policy:${policy.id}:${check}`,
  }));
}
export type SchedulePolicyEvidence = {
  checker: "schedule/1";
  checkerVersion?: string;
  caseId: string;
  policyId: string;
  policyHash: string;
  candidateVersionId: string;
  candidateProgramHash?: string;
  member: string;
  memberVersionId: string;
  sourceCase: SchedulePolicy["fireCase"];
  expected: { state: string; fields: Record<string, string> };
  steps: {
    operation: string;
    at: string;
    state: string;
    fields: Record<string, string>;
    revision: number;
  }[];
  status: "passed" | "failed";
  diagnostic: string;
};
