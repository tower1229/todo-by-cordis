import { useRef, useState } from "react";
import { ArrowUp, Check, Circle, CircleAlert, Sparkles } from "lucide-react";
import type { AssistantEvent, AssistantStep } from "../shared/assistant.js";
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
            {step.attempt && step.attempt > 1 ? ` · 第 ${step.attempt} 次` : ""}
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

function EventLog({ events }: { events: AssistantEvent[] }) {
  if (!events.length) return null;
  return (
    <details className="text-xs leading-6 text-muted break-all">
      <summary className="cursor-pointer">执行日志</summary>
      <ol className="mt-2 space-y-1">
        {events.map((event) => (
          <li key={event.sequence}>
            #{event.sequence}
            {event.tool ? ` · ${event.tool}` : ""} {event.label} ·{" "}
            {event.status}
            {event.detail ? ` · ${event.detail}` : ""}
          </li>
        ))}
      </ol>
    </details>
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
  const [editing, setEditing] = useState(false);
  const unconfigured = snapshot?.availability === "unconfigured";
  const locked =
    run?.status === "executing" || run?.status === "awaiting-apply";
  const hideComposer = (run?.status === "ready" && !editing) || locked;
  const canSend =
    snapshot?.availability === "ready" &&
    !busy &&
    !working &&
    !hideComposer &&
    Boolean(draft.trim());
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        {!run && (
          <div className="pt-5">
            <Sparkles className="mb-4 size-6 text-accent" strokeWidth={1.5} />
            <p className="text-base font-medium">有什么需要调整？</p>
            <p className="mt-2 text-sm leading-6 text-muted">
              描述希望应用增加或改变的能力，先调查并展示计划。
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
        {(run?.status === "ready" || (run?.status === "blocked" && run.plan)) &&
          run.plan && (
            <section className="space-y-5" aria-label="待确认方案">
              <h3 className="text-[15px] font-semibold">
                执行计划 · 需求修订 {run.plan.requestRevision}
              </h3>
              <dl className="space-y-4 text-sm leading-6">
                {[
                  ["目标", run.plan.summary],
                  ["最终效果", run.plan.outcome],
                  ["数据影响", run.plan.dataImpact],
                  ["兼容方式", run.plan.compatibility],
                  ["撤回方式", run.plan.rollback],
                  ["候选体验", run.plan.preview],
                  ["应用方式", run.plan.application],
                  ["重启影响", run.plan.restartImpact],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="plan-label">{label}</dt>
                    <dd className="break-words">{value}</dd>
                  </div>
                ))}
                {!!run.plan.ruleChanges.length && (
                  <div>
                    <dt className="plan-label">业务规则修订</dt>
                    <dd>
                      {run.plan.ruleChanges.map((c, i) => (
                        <p key={i}>{c}</p>
                      ))}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="plan-label">具体改动</dt>
                  <dd>
                    {run.plan.changes.map((c, i) => (
                      <p key={i}>{c}</p>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="plan-label">验收条件</dt>
                  <dd>
                    <ul>
                      {run.plan.acceptance?.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
                <div>
                  <dt className="plan-label">大致步骤</dt>
                  <dd>
                    <ol className="list-decimal pl-5">
                      {run.plan.steps.map((s) => (
                        <li key={s.id}>
                          {s.purpose} · {s.artifact}
                        </li>
                      ))}
                    </ol>
                  </dd>
                </div>
                <div>
                  <dt className="plan-label">能力差异</dt>
                  <dd>
                    {run.plan.capabilityChanges.map((c, i) => (
                      <p key={i}>
                        {c.capability}：{c.change}
                      </p>
                    ))}
                  </dd>
                </div>
                <div>
                  <dt className="plan-label">不包含</dt>
                  <dd>{run.plan.excluded.join("；") || "无额外排除项"}</dd>
                </div>
                <div>
                  <dt className="plan-label">未决项</dt>
                  <dd>{run.plan.unresolved.join("；") || "无"}</dd>
                </div>
              </dl>
              <details className="text-xs leading-6 text-muted break-all">
                <summary>调查证据与修改范围</summary>
                <p>基础版本：{run.plan.baseVersion}</p>
                <p>修改范围：{run.plan.writableScope.join("、")}</p>
                <p>依赖：{run.plan.dependencies.join("、") || "无新增依赖"}</p>
                {run.plan.evidence.map((e) => (
                  <p key={e.ref}>
                    {e.ref} · {e.hash}
                  </p>
                ))}
                {run.plan.steps.map((s) => (
                  <p key={s.id}>
                    {s.purpose}；依赖：{s.dependsOn.join("、") || "无"}
                    ；完成证据：{s.evidence}
                  </p>
                ))}
              </details>
              {run.status === "ready" && (
                <p className="text-xs text-muted">
                  开始执行后将锁定需求并生成候选；验证通过后仍须另行确认应用。
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {run.status === "ready" && (
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      command({
                        type: "start",
                        runId: run.id,
                        planId: run.plan.id,
                      })
                    }
                  >
                    开始执行{busy && <Spinner />}
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    setDraft(run.request);
                  }}
                >
                  修改需求
                </Button>
                <Button
                  disabled={busy}
                  onClick={() => command({ type: "cancel", runId: run.id })}
                >
                  放弃计划
                </Button>
              </div>
            </section>
          )}
        {(run?.status === "blocked" ||
          run?.status === "interrupted" ||
          run?.status === "dismissed") && (
          <p role="status" className="text-sm leading-6">
            {run.message}
          </p>
        )}
        {run?.status === "awaiting-confirmation" && (
          <p>旧方案需要重新调查，不能作为执行或应用授权。</p>
        )}
        {run?.budget && (
          <p className="text-xs text-muted">
            模型调用 {run.budget.callsUsed} 次，剩余 {run.budget.callsRemaining}{" "}
            次；候选预算 {run.budget.candidatesRemaining}；活动时间剩余{" "}
            {Math.ceil(run.budget.millisecondsRemaining / 1000)} 秒
          </p>
        )}
        {!!run?.revisions?.length &&
          run.status !== "executing" &&
          run.status !== "awaiting-apply" && (
            <details className="text-sm">
              <summary>需求与计划历史</summary>
              {run.revisions.map((r) => (
                <p
                  key={r.revision}
                  className="py-2 whitespace-pre-wrap break-words"
                >
                  修订 {r.revision}：{r.text}
                </p>
              ))}
              {run.plans?.map((p) => (
                <p key={p.id}>
                  修订 {p.requestRevision} 的计划：{p.summary}
                </p>
              ))}
            </details>
          )}
        {run?.status === "executing" && (
          <section className="space-y-5" aria-label="执行进度">
            <p role="status" className="text-sm font-medium">
              正在执行 · 需求已锁定
            </p>
            <Steps steps={run.steps} />
            <EventLog events={snapshot?.events ?? []} />
            <p className="text-xs leading-5 text-muted">
              可以收起助手继续使用 Todo，回来后会恢复同一次执行。
            </p>
          </section>
        )}
        {run?.status === "awaiting-apply" && (
          <section className="space-y-5" aria-label="候选结果">
            <p
              role="status"
              className="flex items-start gap-2 text-sm leading-6"
            >
              <Check className="mt-1 size-4 shrink-0 text-accent" />
              {run.summary}
            </p>
            <p className="text-xs text-muted">
              候选已验证且尚未应用到正式环境。正式应用入口将在后续版本开放。
            </p>
            <Steps steps={run.steps} />
            <EventLog events={snapshot?.events ?? []} />
            <Button
              disabled={busy}
              onClick={() => command({ type: "cancel", runId: run.id })}
            >
              放弃候选
            </Button>
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
            <EventLog events={snapshot?.events ?? []} />
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
            {run.status === "executing" ? "停止" : "取消"}
            {busy && <Spinner />}
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
      {!working && !hideComposer && (
        <form
          className="shrink-0 border-t border-line p-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!canSend || composing.current) return;
            if (
              await command({
                ...(run?.status === "awaiting-input"
                  ? { type: "answer" as const, runId: run.id }
                  : editing &&
                      run &&
                      (run.status === "ready" || run.status === "blocked")
                    ? { type: "revise" as const, runId: run.id }
                    : { type: "request" as const }),
                text: draft.trim(),
              })
            ) {
              setDraft("");
              setEditing(false);
            }
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
              placeholder="描述希望应用增加或改变的能力"
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
