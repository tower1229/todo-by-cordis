import { useEffect, useRef, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import type { Task, Field } from "../shared/contracts.js";
import {
  api,
  errorMessage,
  readStored,
  isStringRecord,
  sendCommand,
} from "./api.js";
import { Button, ErrorMessage, Spinner } from "./ui.js";

export function Editor({
  task,
  revision,
  fields,
  saved,
  close,
  remove,
}: {
  task: Task;
  revision: number;
  fields: Field[];
  saved: () => Promise<void>;
  close: () => void;
  remove: () => Promise<void>;
}) {
  const key = `draft:${task.id}`;
  const [draft, setDraft] = useState(() => {
    const stored = readStored(key, {}, isStringRecord);
    return {
      title: stored.title ?? task.title,
      description: stored.description ?? task.description,
    };
  });
  const [base, setBase] = useState(task.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(draft));
  }, [key, draft]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (composing.current || busy || !draft.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await sendCommand({
        type: "edit",
        taskId: task.id,
        expectedRevision: base,
        compositionRevision: revision,
        ...draft,
      });
      localStorage.removeItem(key);
      await saved();
      close();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={submit}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={() => {
        composing.current = false;
      }}
    >
      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <div className="space-y-2">
          <label className="field-label" htmlFor="task-title">
            任务名称
          </label>
          <input
            data-panel-input
            id="task-title"
            className="input"
            required
            maxLength={200}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div className="space-y-2">
          <label className="field-label" htmlFor="task-description">
            备注
          </label>
          <textarea
            id="task-description"
            className="input min-h-36 resize-y"
            maxLength={5000}
            placeholder="添加备注"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </div>
        {Object.entries(task.fields).map(([key, value]) => (
          <div key={key} className="space-y-2">
            <p className="field-label">
              {fields.find((field) => field.key === key)?.label ?? key}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm leading-6">
              {value}
            </p>
          </div>
        ))}
        <ErrorMessage message={error} />
        {error && (
          <Button
            onClick={async () => {
              try {
                const latest = await api<Task>(`/tasks/${task.id}`);
                setBase(latest.revision);
                await saved();
                setError("已读取最新版本，请核对草稿后保存。");
              } catch (error) {
                setError(errorMessage(error));
              }
            }}
          >
            读取最新版本
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line p-4">
        <Button
          variant="icon"
          aria-label="删除任务"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await remove();
            } catch (error) {
              setError(errorMessage(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 className="size-[18px]" />
        </Button>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              localStorage.removeItem(key);
              close();
            }}
          >
            放弃修改
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !draft.title.trim()}
          >
            {busy && <Spinner />}保存
          </Button>
        </div>
      </div>
    </form>
  );
}
