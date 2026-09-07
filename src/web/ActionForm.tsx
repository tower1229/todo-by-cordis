import { useEffect, useRef, useState } from "react";
import type { Task, Field } from "../shared/contracts.js";
import {
  errorMessage,
  readStored,
  isStringRecord,
  sendCommand,
} from "./api.js";
import { Button, ErrorMessage, Spinner } from "./ui.js";
export type ActionForm = {
  task: Task;
  actionId: string;
  label: string;
  fields: Field[];
  revision: number;
};
export function InputForm({
  form,
  done,
  cancel,
}: {
  form: ActionForm;
  done: () => Promise<void>;
  cancel: () => void;
}) {
  const key = `action-draft:${form.task.id}`;
  const [input, setInput] = useState<Record<string, string>>(() =>
    readStored(key, {}, isStringRecord),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(input));
  }, [input, key]);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || composing.current) return;
        setBusy(true);
        setError("");
        try {
          const result = await sendCommand({
            type: "action",
            taskId: form.task.id,
            actionId: form.actionId,
            input,
            expectedRevision: form.task.revision,
            compositionRevision: form.revision,
          });
          if (result.decision?.kind === "input-required") {
            setError("请补充必填内容");
            return;
          }
          localStorage.removeItem(key);
          await done();
          cancel();
        } catch (error) {
          setError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <p className="break-words text-sm text-muted">{form.task.title}</p>
        {form.fields.map((field, index) => (
          <div className="space-y-2" key={field.key}>
            <label className="field-label" htmlFor={`field-${field.key}`}>
              {field.label}
            </label>
            {field.description && (
              <p className="text-xs leading-5 text-muted">
                {field.description}
              </p>
            )}
            <textarea
              data-panel-input={index === 0 ? "" : undefined}
              id={`field-${field.key}`}
              className="input min-h-32"
              required={field.required}
              maxLength={5000}
              value={input[field.key] ?? ""}
              onChange={(e) =>
                setInput({ ...input, [field.key]: e.target.value })
              }
            />
          </div>
        ))}
        <ErrorMessage message={error} />
      </div>
      <div className="flex justify-end gap-2 border-t border-line p-4">
        <Button variant="ghost" onClick={cancel}>
          取消
        </Button>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy && <Spinner />}
          {form.label}
        </Button>
      </div>
    </form>
  );
}
