/** Existing task.detail rendering, shared as a read-only technical fact. */
export function readOnlyFieldText(value: string | undefined): string {
  return value || "（空）";
}
