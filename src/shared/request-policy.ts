/** The browser checker must allow the same request window as the actual page. */
export const apiRequestTimeoutMs = 15_000;
export const experienceRequestTimeoutMs = 30_000;

export function apiRequestTimeout(path: string, body?: unknown): number {
  return path === "/assistant/commands" && body !== null &&
    typeof body === "object" && "type" in body && body.type === "experience"
    ? experienceRequestTimeoutMs
    : apiRequestTimeoutMs;
}
