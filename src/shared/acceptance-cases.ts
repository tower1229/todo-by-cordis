/** Commit or reject expectation for a frozen Given/When/Then case. */
export type AcceptanceExpected =
  | { kind: "reject" }
  | { kind: "commit"; state: string; fields: Record<string, string> };

/** Frozen auxiliary-member case interpreted by the isolated Workspace checker. */
export type MemberAcceptanceCase = {
  name: string;
  member: string;
  state: string;
  fields: Record<string, string>;
  action: string;
  input: Record<string, string>;
  expected: AcceptanceExpected;
};
