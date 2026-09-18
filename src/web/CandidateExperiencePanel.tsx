import { useCallback, useEffect, useRef, useState } from "react";
import type { ExperienceSessionSnapshot } from "../server/experience-session.js";
import { Editor } from "./TaskEditor.js";
import { InputForm, type ActionForm } from "./ActionForm.js";
import {
  clearStoredExperienceSession,
  experienceClient,
  experienceGoneError,
  errorMessage,
  isExperienceGone,
  isExperienceSnapshot,
  readExperienceSession,
  writeStoredExperienceSession,
  type ExperienceClient,
} from "./experience-api.js";
import { Button, ErrorMessage, Spinner } from "./ui.js";
import { experienceSessionBanner } from "../shared/assistant.js";

export function CandidateExperiencePanel({
  sessionId,
  runId,
  onClose,
}: {
  sessionId: string;
  runId: string;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ExperienceSessionSnapshot>();
  const [client, setClient] = useState<ExperienceClient>();
  const [actionPanel, setActionPanel] = useState<ActionForm>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contributionError, setContributionError] = useState("");
  const locked = useRef(false);

  const load = useCallback(async () => {
    const result = await readExperienceSession({ sessionId, runId });
    if (isExperienceGone(result)) {
      clearStoredExperienceSession();
      throw experienceGoneError(result, true);
    }
    if (!isExperienceSnapshot(result)) {
      clearStoredExperienceSession();
      throw experienceGoneError({ status: "none" }, true);
    }
    setSnapshot(result);
    setClient(experienceClient(result.id));
    writeStoredExperienceSession({
      sessionId: result.id,
      runId: result.runId,
    });
  }, [runId, sessionId]);

  useEffect(() => {
    void load().catch((err) => setError(errorMessage(err)));
  }, [load]);

  async function refreshAfterWrite() {
    if (!client) return;
    const next = await client.refresh();
    setSnapshot(next);
  }

  async function runContribution(
    action: { id: string; label: string },
    trigger: HTMLElement,
  ) {
    if (!snapshot || !client || locked.current) return;
    locked.current = true;
    setBusy(true);
    setContributionError("");
    try {
      const result = await client.sendCommand({
        type: "action",
        taskId: snapshot.task.id,
        actionId: action.id,
        expectedRevision: snapshot.task.revision,
      });
      if (result.decision?.kind === "input-required")
        setActionPanel({
          task: snapshot.task,
          actionId: action.id,
          label: action.label,
          fields: result.decision.fields,
          revision: snapshot.composition.revision,
          experienceSessionId: snapshot.id,
        });
      else if (result.task) {
        setSnapshot({ ...snapshot, task: result.task });
      } else await refreshAfterWrite();
    } catch (err) {
      setContributionError(errorMessage(err));
    } finally {
      locked.current = false;
      setBusy(false);
      trigger.focus();
    }
  }

  async function closeExperience() {
    if (client) await client.end().catch(() => undefined);
    clearStoredExperienceSession();
    onClose();
  }

  if (!snapshot || !client) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        {error ? (
          <div className="space-y-3">
            <ErrorMessage message={error} />
            <Button variant="ghost" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <Spinner label="正在打开候选体验" />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="status"
        className="border-b border-line bg-accent-soft px-5 py-3 text-xs leading-5 text-accent"
        aria-label="候选体验提示"
      >
        {experienceSessionBanner}。{snapshot.note}
      </div>
      {error && (
        <div className="px-5 pt-4">
          <ErrorMessage message={error} />
        </div>
      )}
      {!actionPanel && (
        <div
          className="flex flex-wrap gap-2 border-b border-line px-5 py-3"
          aria-label="体验任务操作"
        >
          {(snapshot.composition.workflow.actions ?? [])
            .filter(
              (action) =>
                action.from.includes(snapshot.task.state) &&
                !(snapshot.composition.uiContributions ?? []).some(
                  (contribution) =>
                    contribution.actions.some(
                      (item) => item.commandId === action.id,
                    ),
                ),
            )
            .map((action) => (
              <Button
                key={action.id}
                variant="secondary"
                disabled={busy}
                onClick={(event) =>
                  void runContribution(action, event.currentTarget)
                }
              >
                {action.label}
              </Button>
            ))}
        </div>
      )}
      {actionPanel ? (
        <InputForm
          key={`${actionPanel.task.id}:${actionPanel.actionId}`}
          form={actionPanel}
          done={async () => {
            await refreshAfterWrite();
            setActionPanel(undefined);
          }}
          cancel={() => setActionPanel(undefined)}
        />
      ) : (
        <Editor
          key={snapshot.task.id}
          task={snapshot.task}
          revision={snapshot.composition.revision}
          fields={snapshot.composition.retainedFields}
          contributions={snapshot.composition.uiContributions ?? []}
          faults={snapshot.composition.uiContributionFaults ?? []}
          availableActionIds={
            new Set(
              (snapshot.composition.workflow.actions ?? [])
                .filter((action) =>
                  action.from.includes(snapshot.task.state),
                )
                .map((action) => action.id),
            )
          }
          saved={refreshAfterWrite}
          close={() => void closeExperience()}
          remove={async () => {
            setContributionError("体验任务不支持删除");
          }}
          contributionBusy={busy}
          contributionError={contributionError}
          onContributionAction={runContribution}
          experienceSessionId={snapshot.id}
        />
      )}
      <div className="border-t border-line px-5 py-4">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void closeExperience()}
        >
          结束体验
        </Button>
      </div>
    </div>
  );
}
