import { useEffect, useRef, useState } from "react";
import type { Task, Field } from "../shared/contracts.js";
import { sendCommand } from "./api.js";
import { Icon } from "./Icon.js";
export type ActionForm = {
  task: Task;
  actionId: string;
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
    JSON.parse(localStorage.getItem(key) ?? "{}"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(input));
  }, [input, key]);
  return (
    <section className="editor">
      <div className="panel-top">
        <span className="eyebrow">给完成，留一点回响</span>
        <button className="icon-button" onClick={cancel} aria-label="取消复盘">
          <Icon name="close" />
        </button>
      </div>
      <h2>最后，一点小小的收获</h2>
      <p className="subtext">{form.task.title}</p>
      <form
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onSubmit={async (e) => {
          e.preventDefault();
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
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {form.fields.map((f) => (
          <div key={f.key}>
            <label htmlFor={`field-${f.key}`}>{f.label}</label>
            {f.description && <p className="field-help">{f.description}</p>}
            <textarea
              id={`field-${f.key}`}
              autoFocus
              rows={5}
              required={f.required}
              value={input[f.key] ?? ""}
              onChange={(e) => setInput({ ...input, [f.key]: e.target.value })}
            />
          </div>
        ))}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="form-footer">
          <button className="text-button" type="button" onClick={cancel}>
            先不完成
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "留下复盘并完成"}
          </button>
        </div>
      </form>
    </section>
  );
}
