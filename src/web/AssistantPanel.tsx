import { useRef } from "react";
import { ArrowUp, Check, Circle, CircleAlert, Sparkles } from "lucide-react";
import type { AssistantStep } from "../shared/assistant.js";
import type { AssistantController } from "./useAssistant.js";
import { Button, ErrorMessage, Spinner } from "./ui.js";

function Steps({ steps }: { steps: AssistantStep[] }) {
  return (
    <ol className="space-y-4" aria-label="执行进度">
      {steps.map((step) => (
        <li key={step.id} className="flex items-center gap-3 text-sm">
          {step.status === "running" ? (
            <Spinner />
          ) : step.status === "succeeded" ? (
            <Check className="size-4 text-accent" />
          ) : step.status === "failed" ? (
            <CircleAlert className="size-4 text-danger" />
          ) : (
            <Circle className="size-4 text-muted/50" />
          )}
          <span className={step.status === "pending" ? "text-muted" : ""}>
            {step.label}
          </span>
          <span className="sr-only">
            {
              {
                pending: "等待中",
                running: "进行中",
                succeeded: "已完成",
                failed: "失败",
              }[step.status]
            }
          </span>
        </li>
      ))}
    </ol>
  );
}
export function AssistantPanel({
  controller,
}: {
  controller: AssistantController;
}) {
  const { snapshot, error, busy, draft, setDraft, command, working } =
    controller;
  const run = snapshot?.run;
  const composing = useRef(false);
  const unconfigured = snapshot?.availability === "unconfigured";
  const awaiting = run?.status === "awaiting-confirmation";
  const canSend =
    snapshot?.availability === "ready" &&
    !busy &&
    !working &&
    !awaiting &&
    Boolean(draft.trim());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        {!run && (
          <div className="pt-5">
            <Sparkles className="mb-4 size-6 text-accent" strokeWidth={1.5} />
            <p className="text-base font-medium">有什么需要调整？</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              说说需求，先确认方案，再执行。
            </p>
          </div>
        )}
        {run && (
          <p className="rounded-lg bg-canvas p-3 text-sm leading-6 break-words whitespace-pre-wrap">
            {run.request}
          </p>
        )}
        {run?.status === "planning" && (
          <div role="status" className="flex items-center gap-3 text-sm">
            <Spinner />
            正在理解需求并整理方案…
          </div>
        )}
        {run?.status === "awaiting-input" && (
          <p className="text-sm leading-6">{run.question}</p>
        )}
        {run?.status === "awaiting-confirmation" && (
          <section className="space-y-5" aria-label="待确认方案">
            <h3 className="text-[15px] font-semibold">确认方案</h3>
            <dl className="space-y-4 text-sm leading-6">
              <div>
                <dt className="plan-label">需求理解</dt>
                <dd>{run.plan.summary}</dd>
              </div>
              <div>
                <dt className="plan-label">处理方式</dt>
                <dd>
                  {run.plan.route.kind === "task"
                    ? "操作任务"
                    : run.plan.route.kind === "create-plugin"
                      ? `新建插件 · ${run.plan.route.name}`
                      : `修改现有插件 · ${run.plan.route.name}`}
                </dd>
              </div>
              <div>
                <dt className="plan-label">具体改动</dt>
                <dd>
                  <ul className="list-disc space-y-1 pl-4">
                    {run.plan.changes.map((change, i) => (
                      <li key={i}>{change}</li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt className="plan-label">最终效果</dt>
                <dd>{run.plan.outcome}</dd>
              </div>
              <div>
                <dt className="plan-label">数据影响</dt>
                <dd>{run.plan.dataImpact}</dd>
              </div>
              {run.plan.acceptance?.length ? (
                <div>
                  <dt className="plan-label">验收条件</dt>
                  <dd>
                    <ul>
                      {run.plan.acceptance.map((condition) => (
                        <li key={condition}>{condition}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ) : null}
            </dl>
            <div className="flex gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  command({
                    type: "confirm",
                    runId: run.id,
                    planId: run.plan.id,
                    compositionRevision: run.plan.compositionRevision,
                  })
                }
              >
                {busy && <Spinner />}确认执行
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  if (await command({ type: "cancel", runId: run.id }))
                    setDraft(run.request);
                }}
              >
                修改需求
              </Button>
            </div>
          </section>
        )}
        {run?.status === "executing" && (
          <section className="space-y-5" aria-label="执行状态">
            <p role="status" className="text-sm font-medium">
              正在执行
            </p>
            <Steps steps={run.steps} />
            <p className="text-xs leading-5 text-muted">
              可以收起助手，完成后会通知你。
            </p>
          </section>
        )}
        {run?.status === "succeeded" && (
          <section className="space-y-5">
            <p
              role="status"
              className="flex items-start gap-2 text-sm leading-6"
            >
              <Check className="mt-1 size-4 shrink-0 text-accent" />
              {run.summary}
            </p>
            <details className="text-sm text-muted">
              <summary className="cursor-pointer">执行详情</summary>
              <div className="pt-4">
                <Steps steps={run.steps} />
              </div>
            </details>
          </section>
        )}
        {run?.status === "failed" && (
          <div className="space-y-4">
            <ErrorMessage message={run.message} />
            <Steps steps={run.steps} />
            <Button onClick={() => setDraft(run.request)}>修改后重试</Button>
          </div>
        )}
        {run?.status === "cancelled" && (
          <p role="status" className="text-sm text-muted">
            已取消
          </p>
        )}
        {(working || run?.status === "awaiting-input") && run && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => command({ type: "cancel", runId: run.id })}
          >
            取消{busy && <Spinner />}
          </Button>
        )}
        <ErrorMessage message={error} />
        {!snapshot && !error && (
          <div role="status" className="flex gap-2 text-sm text-muted">
            <Spinner />
            正在连接…
          </div>
        )}
      </div>
      {!working && !awaiting && (
        <form
          className="shrink-0 border-t border-line p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSend || composing.current) return;
            if (
              await command({
                type: "request",
                text: draft.trim(),
                ...(run?.status === "awaiting-input" ? { runId: run.id } : {}),
              })
            )
              setDraft("");
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        >
          {unconfigured && (
            <p className="mb-3 text-xs text-muted">
              AI 尚未连接。可以先记下需求。
            </p>
          )}
          <div className="rounded-lg border border-line bg-surface p-2 focus-within:border-accent">
            <textarea
              data-panel-input
              aria-label="告诉 AI 你的需求"
              className="w-full resize-none border-0 bg-transparent p-2 text-sm leading-6 outline-none"
              rows={3}
              placeholder="描述你想做的事…"
              maxLength={5000}
              disabled={busy}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="primary"
                className="min-h-9 w-9 p-0"
                aria-label="发送需求"
                disabled={!canSend}
              >
                {busy ? <Spinner /> : <ArrowUp className="size-[18px]" />}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
