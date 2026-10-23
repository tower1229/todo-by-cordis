import type { AssistantCommand } from "../../src/shared/assistant.js";
import type { Evolution } from "../../src/evolution/evolution.js";

/** Bind authored text fixtures to the currently published question contract. */
export async function answerCurrent(
  e: Pick<Evolution, "observe" | "command">,
  command: Extract<AssistantCommand, { type: "answer" | "revise" }>,
) {
  const run = (await e.observe(command.runId)).run;
  if (run?.status !== "awaiting-input" || !run.questions?.length)
    return e.command(command);
  return e.command({
    ...command,
    questionRevision: run.questionRevision,
    answers: run.questions.map((q) => ({
      questionId: q.id,
      text: command.text,
    })),
  });
}
