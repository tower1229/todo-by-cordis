import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  Composition,
  Task,
  TaskList,
  Field,
} from "../shared/contracts.js";
import { api, sendCommand } from "./api.js";
import "./style.css";
import { Icon } from "./Icon.js";
import { Editor } from "./TaskEditor.js";
import { InputForm, type ActionForm } from "./ActionForm.js";
import { EvolutionPanel } from "./EvolutionPanel.js";

function App() {
  const [page, setPage] = useState(
    location.pathname === "/evolve" ? "evolve" : "tasks",
  );
  const [selection, setSelection] = useState<string | null>(null);
  const [selected, setSelected] = useState<Task>();
  const [composition, setComposition] = useState<Composition>();
  const [list, setList] = useState<TaskList>();
  const [category, setCategory] = useState("open");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [form, setForm] = useState<ActionForm>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [undo, setUndo] = useState<Task>();
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++latest.current;
    const [pages, nextComposition] = await Promise.all([
      Promise.all(
        Array.from({ length: Math.floor(offset / 100) + 1 }, (_, i) =>
          api<TaskList>(
            `/tasks?category=${category}&search=${encodeURIComponent(search)}&offset=${i * 100}`,
          ),
        ),
      ),
      api<Composition>("/composition"),
    ]);
    if (request !== latest.current) return;
    setComposition(nextComposition);
    setList({ ...pages[0], tasks: pages.flatMap((page) => page.tasks) });
  }, [category, search, offset]);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        refresh().catch((e) => setError(e.message));
      },
      search ? 180 : 0,
    );
    return () => clearTimeout(timer);
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => {
      refresh().catch((e) => setError(e.message));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  useEffect(() => {
    if (selection && selection !== "new")
      api<Task>(`/tasks/${selection}`)
        .then(setSelected)
        .catch((e) => setError(e.message));
    else setSelected(undefined);
  }, [selection]);
  useEffect(() => {
    const change = () => {
      setPage(location.pathname === "/evolve" ? "evolve" : "tasks");
      setSelection(null);
      setForm(undefined);
    };
    window.addEventListener("popstate", change);
    return () => window.removeEventListener("popstate", change);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  function navigate(next: string) {
    setPage(next);
    setSelection(null);
    setForm(undefined);
    history.pushState({}, "", next === "evolve" ? "/evolve" : "/");
  }
  async function action(task: Task, actionId: string) {
    if (busy || !composition) return;
    setBusy(true);
    setError("");
    try {
      const result = await sendCommand({
        type: "action",
        taskId: task.id,
        actionId,
        expectedRevision: task.revision,
        compositionRevision: composition.revision,
      });
      if (result.decision?.kind === "input-required") {
        setSelection(null);
        setForm({
          task,
          actionId,
          fields: result.decision.fields,
          revision: composition.revision,
        });
      } else {
        setNotice("又向前走了一小步");
        await refresh();
      }
    } catch (e: any) {
      setError(e.message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function remove(task: Task) {
    if (!composition || busy) return;
    setBusy(true);
    try {
      const result = await sendCommand({
        type: "delete",
        taskId: task.id,
        expectedRevision: task.revision,
        compositionRevision: composition.revision,
      });
      setUndo(result.task);
      setSelection(null);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleFlow() {
    if (!composition || busy) return;
    setBusy(true);
    setError("");
    const request = {
      workflowId: composition.workflow.id === "default" ? "review" : "default",
      compositionRevision: composition.revision,
    };
    const key = JSON.stringify(request);
    const pending = JSON.parse(localStorage.getItem("release-pending") ?? "{}");
    const operationId = pending[key] ?? crypto.randomUUID();
    pending[key] = operationId;
    localStorage.setItem("release-pending", JSON.stringify(pending));
    try {
      await api("/releases", { ...request, operationId });
      delete pending[key];
      localStorage.setItem("release-pending", JSON.stringify(pending));
      await refresh();
      setNotice("新的流程，已经准备好了");
    } catch (e: any) {
      setError(e.message);
      if (e.code) {
        delete pending[key];
        localStorage.setItem("release-pending", JSON.stringify(pending));
      }
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const refreshAfterWrite = async () => {
    try {
      await refresh();
    } catch (error: any) {
      setError(`已保存，但列表暂时无法刷新：${error.message}`);
    }
  };
  const closePanel = () => {
    setSelection(null);
    setForm(undefined);
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(".add")?.focus(),
    );
  };
  const hasPanel = Boolean(selection || form);
  const today = new Date().toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const assistantState = busy
    ? "working"
    : error
      ? "error"
      : notice
        ? "success"
        : "idle";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate("tasks");
          }}
        >
          <span className="brand-mark">✳</span>
          <span>
            哆啦AI梦<small>TODO BY CORDIS</small>
          </span>
        </a>
        <div className="workspace-label">我的小小工作区</div>
        <nav>
          {[
            ["tasks", "待办"],
            ["evolve", "进化"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-label={label}
              className={page === id ? "nav-item active" : "nav-item"}
              onClick={() => navigate(id)}
            >
              <Icon name={id} />
              <span>{label}</span>
              {id === "tasks" && (
                <span className="nav-count">{list?.counts.open ?? "·"}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          保存在这台电脑<small>一点一滴，都在这里。</small>
        </div>
      </aside>
      <main
        className={`main ${hasPanel ? "panel-open" : ""} ${page === "evolve" ? "evolve-page" : ""}`}
      >
        <header className="topbar">
          <span>{today}</span>
          <span className="local-badge">
            <span className="status-dot" />
            个人空间
          </span>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button
              className="text-button"
              onClick={() => {
                setError("");
                refresh().catch((e) => setError(e.message));
              }}
            >
              重新连接
            </button>
          </div>
        )}
        {composition?.status !== "ready" && composition && (
          <div className="error-banner">
            流程暂时休息中，任务仍保存在这里。
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await api("/runtime/retry", {});
                  await refresh();
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              重试运行环境
            </button>
          </div>
        )}
        <div className="content-grid">
          <section className="task-space">
            <div className="heading">
              <div>
                <span className="eyebrow">MAKE ROOM FOR WHAT MATTERS</span>
                <h1>
                  把想法，慢慢变成日常<span className="heading-dot">.</span>
                </h1>
                <p>从一件小事开始，给新的可能留一点空间。</p>
              </div>
              <button
                className="primary add"
                onClick={() => {
                  setForm(undefined);
                  setSelection("new");
                }}
              >
                <Icon name="plus" />
                新增任务
              </button>
            </div>
            <div className="list-toolbar">
              <div className="filters" aria-label="任务筛选">
                {[
                  ["open", "未完成"],
                  ["all", "全部"],
                  ["done", "已完成"],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    aria-pressed={category === id}
                    className={category === id ? "selected" : ""}
                    onClick={() => {
                      setCategory(id);
                      setOffset(0);
                    }}
                  >
                    {label}
                    {id === "open" && <span>{list?.counts.open ?? 0}</span>}
                  </button>
                ))}
              </div>
              <div className="search">
                <Icon name="search" />
                <input
                  aria-label="搜索任务"
                  placeholder="搜索任务"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOffset(0);
                  }}
                />
              </div>
            </div>
            {!list ? (
              <div className="skeleton" aria-label="正在读取任务">
                <i />
                <i />
                <i />
              </div>
            ) : !list.tasks.length ? (
              <div className="empty">
                <div className="empty-symbol">
                  <Icon name="tasks" />
                </div>
                <h2>
                  {search
                    ? "暂时没有找到"
                    : category === "done"
                      ? "每一次完成，都值得留下"
                      : "今天，想从什么开始？"}
                </h2>
                <p>
                  {search
                    ? "换个关键词，或看看全部任务。"
                    : "不必一下子安排所有事情。\n先写下此刻最想做的一件。"}
                </p>
                <button className="primary" onClick={() => setSelection("new")}>
                  <Icon name="plus" />
                  写下第一件事
                </button>
                {!search && category !== "done" && (
                  <button
                    className="text-button demo-link"
                    disabled={busy}
                    onClick={async () => {
                      if (!composition) return;
                      setBusy(true);
                      try {
                        for (const [title, description] of [
                          [
                            "给今天留出 20 分钟阅读",
                            "打开那本一直想读的书，哪怕只读几页。",
                          ],
                          [
                            "整理一个让自己舒服的角落",
                            "从桌面开始，给想法腾出一点空间。",
                          ],
                          [
                            "试试，让待办学会复盘",
                            "去「进化」体验一次流程变化。",
                          ],
                        ])
                          await sendCommand({
                            type: "create",
                            compositionRevision: composition.revision,
                            title,
                            description,
                          });
                        await refresh();
                      } catch (e: any) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    或载入三件示例任务 <span>↗</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="task-list">
                {list.tasks.map((task) => {
                  const definition = composition?.workflow;
                  const actions =
                    definition?.actions.filter((a) =>
                      a.from.includes(task.state),
                    ) ?? [];
                  const done =
                    definition?.states[task.state]?.category === "done";
                  return (
                    <article
                      className={`task-row ${done ? "done" : ""}`}
                      key={task.id}
                    >
                      <button
                        className="task-check"
                        aria-label={`${actions[0]?.label ?? "操作"} ${task.title}`}
                        disabled={busy || !actions.length}
                        onClick={() => action(task, actions[0].id)}
                      >
                        {done && <Icon name="check" />}
                      </button>
                      <button
                        className="task-body"
                        onClick={() => {
                          setForm(undefined);
                          setSelection(task.id);
                        }}
                      >
                        <strong>{task.title}</strong>
                        {task.description && <p>{task.description}</p>}
                        <span className="task-meta">
                          {task.fields.review ? "✧ 留下了复盘" : "个人待办"}
                          <span>·</span>
                          {new Date(task.createdAt).toLocaleDateString(
                            "zh-CN",
                            { month: "short", day: "numeric" },
                          )}
                        </span>
                      </button>
                      <button
                        className="row-more"
                        aria-label={`删除 ${task.title}`}
                        disabled={busy}
                        onClick={() => remove(task)}
                      >
                        ×
                      </button>
                    </article>
                  );
                })}
                {list.tasks.length < list.total && (
                  <button
                    className="text-button load-more"
                    onClick={() => setOffset(list.tasks.length)}
                  >
                    加载更多
                  </button>
                )}
                <div className="list-end">
                  一点进展，也很好。<span>✳</span>
                </div>
              </div>
            )}
          </section>
          <aside className={`right-panel ${hasPanel ? "detail-visible" : ""}`}>
            {hasPanel && (
              <button className="mobile-back text-button" onClick={closePanel}>
                <Icon name="back" />
                返回待办
              </button>
            )}
            {form ? (
              <InputForm
                key={`${form.task.id}:${form.revision}`}
                form={form}
                done={async () => {
                  await refreshAfterWrite();
                  setNotice("这次完成，有了自己的回响");
                }}
                cancel={closePanel}
              />
            ) : selection ? (
              selection === "new" || selected?.id === selection ? (
                <Editor
                  key={selection}
                  task={selection === "new" ? undefined : selected}
                  revision={composition?.revision ?? 1}
                  fields={composition?.retainedFields ?? []}
                  saved={refreshAfterWrite}
                  close={closePanel}
                />
              ) : (
                <p>正在打开…</p>
              )
            ) : (
              <>
                <EvolutionPanel
                  composition={composition}
                  busy={busy}
                  toggleFlow={toggleFlow}
                  assistantState={assistantState}
                />
              </>
            )}
          </aside>
        </div>
      </main>
      <nav className="mobile-nav" aria-label="主要导航">
        {[
          ["tasks", "待办"],
          ["evolve", "进化"],
        ].map(([id, label]) => (
          <button
            key={id}
            aria-label={label}
            className={page === id ? "active" : ""}
            onClick={() => navigate(id)}
          >
            <Icon name={id} />
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" />
          {notice}
        </div>
      )}
      {undo && (
        <div className="undo-toast" role="status">
          <span>任务已收好</span>
          <button
            disabled={busy}
            onClick={async () => {
              if (!composition) return;
              setBusy(true);
              try {
                await sendCommand({
                  type: "restore",
                  taskId: undo.id,
                  expectedRevision: undo.revision,
                  compositionRevision: composition.revision,
                });
                setUndo(undefined);
                await refresh();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            撤销删除
          </button>
          <button aria-label="关闭撤销提示" onClick={() => setUndo(undefined)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
