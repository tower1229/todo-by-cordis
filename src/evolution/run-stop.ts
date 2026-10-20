import type { RunStop } from "../shared/assistant.js";
import { ModelTransportError } from "./driver.js";
import { ModelProtocolError, ModelResourceError } from "./model-protocol.js";
import { BudgetExhaustedError } from "./budget.js";

export function stopForError(
  error: unknown,
  phase: string,
  call: number,
  signal: AbortSignal,
): RunStop | undefined {
  if (
    signal.aborted &&
    signal.reason instanceof DOMException &&
    signal.reason.name === "TimeoutError"
  )
    return {
      kind: "budget",
      phase,
      code: "active-time-budget",
      evidence: ["run.budget"],
    };
  if (error instanceof BudgetExhaustedError)
    return {
      kind: "budget",
      phase: error.phase ?? phase,
      code:
        error.resource === "milliseconds" ? "phase-time-reserve" : error.resource === "candidates" ? "candidate-budget" : "call-reserve",
      evidence: ["run.budget"],
    };
  const evidence = [`model-call:${call}`];
  if (error instanceof ModelTransportError)
    return {
      kind: "transport",
      phase,
      code: `transport:${error.transport?.failure?.kind ?? "http"}`,
      evidence,
    };
  if (error instanceof ModelResourceError)
    return { kind: "output-budget", phase, code: "output-budget", evidence };
  if (error instanceof ModelProtocolError)
    return {
      kind: "protocol",
      phase,
      code: "invalid-model-protocol",
      evidence,
    };
  return undefined;
}
