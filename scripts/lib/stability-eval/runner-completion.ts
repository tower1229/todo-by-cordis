import { writeVerifiedJson } from "./archive.js";

export type RunnerExit = {
  startedAt: string;
  pid?: number;
  exitCode: number | null;
  signal: string | null;
  error?: string;
};

/** Child exit and postflight integrity are separate observations. */
export function recordRunnerCompletion(
  root: string,
  exit: RunnerExit,
  checks: Record<string, () => boolean>,
) {
  const terminalPath = `${root}-runner-terminal.json`;
  const terminalHash = writeVerifiedJson(terminalPath, {
    schema: "stability-runner-terminal/1",
    ...exit,
    exitObservedAt: new Date().toISOString(),
  });
  const results: Record<string, { passed: boolean; diagnostic?: string }> = {};
  for (const [name, check] of Object.entries(checks)) {
    try {
      const passed = check() === true;
      results[name] = {
        passed,
        ...(passed ? {} : { diagnostic: "校验未通过" }),
      };
    } catch (error) {
      results[name] = {
        passed: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const verification = {
    schema: "stability-runner-verification/1",
    terminalPath,
    terminalHash,
    checks: results,
    integrityVerified:
      Object.keys(results).length > 0 &&
      Object.values(results).every((result) => result.passed),
  };
  const verificationPath = `${root}-runner-verification.json`;
  const verificationHash = writeVerifiedJson(verificationPath, verification);
  return { ...verification, verificationPath, verificationHash };
}
