import React, { useEffect, useRef, useState } from "react";
import type { Task, Field } from "../shared/contracts.js";
import { api, sendCommand } from "./api.js";
import { Icon } from "./Icon.js";
const readDraft = (id: string, task?: Task) => {
  try {
    return (
      JSON.parse(localStorage.getItem(`draft:${id}`) ?? "null") ?? {
        title: task?.title ?? "",
        description: task?.description ?? "",
      }
    );
  } catch {
    return { title: task?.title ?? "", description: task?.description ?? "" };
  }
};
export function Editor({
  task,
  revision,
  fields,
  saved,
  close,
}: {
  task?: Task;
  revision: number;
  fields: Field[];
  saved: () => Promise<void>;
  close: () => void;
}) {
  const id = task?.id ?? "new";
  const [draft, setDraft] = useState(() => readDraft(id, task));
  const [base, setBase] = useState(task?.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const composing = useRef(false);
  useEffect(() => {
    localStorage.setItem(`draft:${id}`, JSON.stringify(draft));
  }, [draft, id]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (composing.current || busy) return;
    setBusy(true);
    setError("");
    try {
      await sendCommand({
        type: task ? "edit" : "create",
        taskId: task?.id,
        expectedRevision: base,
        compositionRevision: revision,
        ...draft,
      });
      localStorage.removeItem(`draft:${id}`);
      await saved();
      close();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="editor">
      <div className="panel-top">
        <span className="eyebrow">
          {task ? "留意每一个细节" : "从一件小事开始"}
        </span>
        <button className="icon-button" onClick={close} aria-label="关闭详情">
          <Icon name="close" />
        </button>
      </div>
      <h2>{task ? "任务详情" : "新的待办"}</h2>
      <form
        onSubmit={submit}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      >
        <label htmlFor="title">想做些什么？</label>
        <input
          id="title"
          autoFocus
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          placeholder="写下一个值得开始的小目标"
          required
        />
        <label htmlFor="description">
          补充一点细节 <span>可选</span>
        </label>
        <textarea
          id="description"
          rows={5}
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          placeholder="想法、线索，或给未来自己的提醒…"
        />
        {task &&
          Object.entries(task.fields).map(([key, value]) => (
            <div className="retained-field" key={key}>
              <span>
                {fields.find((field) => field.key === key)?.label ?? key}
              </span>
              <p>{value}</p>
            </div>
          ))}
        {error && (
          <div className="error" role="alert">
            {error}
            {task && (
              <button
                type="button"
                className="text-button"
                onClick={async () => {
                  try {
                    const latest = await api<Task>(`/tasks/${task.id}`);
                    setBase(latest.revision);
                    await saved();
                    setError("已读取最新版本，草稿保留。确认内容后再次保存。");
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                读取最新版本
              </button>
            )}
          </div>
        )}
        <div className="form-footer">
          <span>离开时会保留草稿</span>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存任务"}
            <Icon name="arrow" />
          </button>
        </div>
        <button
          className="text-button muted"
          type="button"
          onClick={() => {
            localStorage.removeItem(`draft:${id}`);
            close();
          }}
        >
          放弃草稿
        </button>
      </form>
    </section>
  );
}
