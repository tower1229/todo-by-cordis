import { useState } from "react";
import type { AssistantRun } from "../shared/assistant.js";
import type { AssistantController } from "./useAssistant.js";
import type {
  ClarificationAnswer,
  ResourceAmounts,
} from "../shared/evolution-interaction.js";
import { Button } from "./ui.js";

export function QuestionForm({
  run,
  controller,
}: {
  run: Extract<AssistantRun, { status: "awaiting-input" }>;
  controller: AssistantController;
}) {
  const questions = run.questions ?? [];
  const storageKey = `assistant-answer:${run.id}:${run.questionRevision}`;
  const [answers, setAnswers] = useState<Record<string, ClarificationAnswer>>(
    () => {
      try {
        return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
      } catch {
        return {};
      }
    },
  );
  const update = (id: string, value: Partial<ClarificationAnswer>) => {
    const next = {
      ...answers,
      [id]: { ...answers[id], questionId: id, ...value },
    };
    setAnswers(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  };
  const ready = questions.every(
    (q) => answers[q.id]?.optionId || answers[q.id]?.text?.trim(),
  );
  return (
    <form
      className="space-y-6"
      aria-label="回答当前问题"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || controller.busy) return;
        if (
          await controller.command({
            type: "answer",
            runId: run.id,
            questionRevision: run.questionRevision,
            answers: questions.map((q) => answers[q.id]),
            text: "提交当前问题的回答",
          })
        )
          sessionStorage.removeItem(storageKey);
      }}
    >
      <h3 className="text-base font-semibold">需要你选择</h3>
      {questions.map((q) => (
        <fieldset key={q.id} className="space-y-3" disabled={controller.busy}>
          <legend className="mb-2 text-sm font-medium leading-6">
            {q.title}
          </legend>
          <p className="text-xs leading-5 text-muted">{q.explanation}</p>
          {q.options.map((o) => (
            <label
              key={o.id}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-2 text-sm has-checked:border-accent has-checked:bg-canvas"
            >
              <input
                type="radio"
                name={q.id}
                value={o.id}
                checked={answers[q.id]?.optionId === o.id}
                onChange={() => update(q.id, { optionId: o.id })}
              />
              <span>
                {o.label}
                {q.recommendedOptionId === o.id && (
                  <span className="ml-2 text-xs text-muted">推荐</span>
                )}
              </span>
            </label>
          ))}
          <label className="block text-xs text-muted">
            {q.options.length ? "补充说明（可选）" : "你的回答"}
            <textarea
              rows={2}
              maxLength={5000}
              className="mt-2 w-full rounded-md border border-line bg-surface p-3 text-sm text-ink focus-visible:outline-accent"
              value={answers[q.id]?.text ?? ""}
              onChange={(e) => update(q.id, { text: e.target.value })}
            />
          </label>
        </fieldset>
      ))}
      <Button
        type="submit"
        variant="primary"
        disabled={!ready || controller.busy}
      >
        提交回答
      </Button>
    </form>
  );
}

export function resourceLabel(amounts: ResourceAmounts) {
  return [
    amounts.calls ? `${amounts.calls} 次调用` : "",
    amounts.milliseconds
      ? `${Math.ceil(amounts.milliseconds / 60000)} 分钟活动时间`
      : "",
    amounts.candidates ? `${amounts.candidates} 个候选机会` : "",
  ]
    .filter(Boolean)
    .join("、");
}

export function BudgetResume({
  run,
  controller,
}: {
  run: Extract<AssistantRun, { status: "awaiting-budget" }>;
  controller: AssistantController;
}) {
  const [amounts, setAmounts] = useState(run.pause.suggested);
  const valid = (["calls", "candidates", "milliseconds"] as const).every(
    (k) =>
      Number.isSafeInteger(amounts[k]) && amounts[k] >= run.pause.minimum[k],
  );
  return (
    <section aria-label="等待追加资源" className="space-y-4">
      <h3 className="text-base font-semibold">需要继续调用模型</h3>
      <p className="text-sm leading-6">
        已保存需求与当前成果，追加资源后将继续
        {run.pause.resume === "execute"
          ? "生成并验证候选，需求仍保持锁定"
          : "整理和复核方案"}
        。
      </p>
      <p className="text-xs leading-5 text-muted">{run.pause.message}</p>
      <p className="text-sm">
        本次追加：{resourceLabel(amounts) || "尚未选择资源"}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">调整额度</summary>
        <div className="mt-3 space-y-3">
          {(
            [
              ["calls", "模型调用", 1],
              ["milliseconds", "活动时间（分钟）", 60000],
              ["candidates", "候选机会", 1],
            ] as const
          ).map(([key, label, unit]) => (
            <label
              key={key}
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              {label}
              <input
                type="number"
                min={Math.ceil(run.pause.minimum[key] / unit)}
                step={1}
                value={amounts[key] / unit}
                onChange={(e) =>
                  setAmounts({
                    ...amounts,
                    [key]: e.target.valueAsNumber * unit,
                  })
                }
                className="min-h-11 w-24 rounded border border-line bg-surface px-2"
              />
            </label>
          ))}
        </div>
      </details>
      {!valid && (
        <p role="alert" className="text-xs text-danger">
          至少需要追加 {resourceLabel(run.pause.minimum)} 才能恢复。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!valid || controller.busy}
          onClick={() =>
            controller.command({
              type: "resume-budget",
              runId: run.id,
              pauseRevision: run.pause.revision,
              amounts,
            })
          }
        >
          继续进行
        </Button>
        <Button
          variant="ghost"
          disabled={controller.busy}
          onClick={() => controller.command({ type: "cancel", runId: run.id })}
        >
          结束本次改进
        </Button>
      </div>
    </section>
  );
}
