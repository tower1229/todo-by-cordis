import type {
  Task,
  ResolvedUiContribution,
  UiContributionFault,
} from "../shared/contracts.js";
import { Button, ErrorMessage } from "./ui.js";

export function TaskDetailContributions({
  task,
  contributions,
  faults = [],
  availableActionIds,
  busy,
  error,
  onAction,
}: {
  task: Task;
  contributions: ResolvedUiContribution[];
  faults?: UiContributionFault[];
  availableActionIds?: ReadonlySet<string>;
  busy: boolean;
  error?: string;
  onAction: (
    action: { id: string; label: string },
    trigger: HTMLElement,
  ) => void;
}) {
  if (!contributions.length && !faults.length) return null;
  return (
    <section className="space-y-4" aria-label="任务详情扩展">
      {contributions.map((contribution) => {
        const actions = contribution.actions.filter(
          (action) =>
            !availableActionIds || availableActionIds.has(action.commandId),
        );
        return (
          <article
            key={`${contribution.providerId}:${contribution.id}`}
            className="space-y-3 border-t border-line pt-4"
            aria-label={contribution.title}
          >
            <div className="space-y-1">
              <h3 className="text-sm font-medium">{contribution.title}</h3>
              {contribution.body && (
                <p className="text-xs leading-5 text-muted">
                  {contribution.body}
                </p>
              )}
            </div>
            {contribution.fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <p className="field-label">{field.label}</p>
                <p className="whitespace-pre-wrap break-words text-sm leading-6">
                  {task.fields[field.key] || "（空）"}
                </p>
              </div>
            ))}
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {actions.map((action) => (
                  <Button
                    key={action.commandId}
                    variant="ghost"
                    disabled={busy}
                    aria-label={`${action.label} ${task.title}`}
                    onClick={(event) =>
                      onAction(
                        { id: action.commandId, label: action.label },
                        event.currentTarget,
                      )
                    }
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            )}
          </article>
        );
      })}
      {faults.map((fault) => (
        <article
          key={`fault:${fault.providerId}:${fault.id}`}
          className="space-y-1 border-t border-line pt-4"
          aria-label="此 UI 贡献不可用"
          role="status"
        >
          <h3 className="text-sm font-medium">此 UI 贡献不可用</h3>
          <p className="text-xs leading-5 text-muted">
            {fault.id}：{fault.reason}
          </p>
        </article>
      ))}
      {error && <ErrorMessage message={error} />}
    </section>
  );
}
