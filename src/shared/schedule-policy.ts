/** Finite business policies. The host owns all time advances and action sequences. */
export const schedulePolicySemantics = {
  "set-past-due":
    "未完成任务直接设置过去截止时间，由宿主在线真实调度补执行冻结的到期效果",
  "reset-clears-effect":
    "未完成任务真实到期后，分别修改为未来截止和用空字符串清除截止，均清除旧到期效果；修改后新截止仍执行，清除后不再执行",
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
