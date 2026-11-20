import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { Context } from "cordis";
import {
  Check,
  CheckCheck,
  Circle,
  Compass,
  ListTodo,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@base-ui/react";
import {
  Slot,
  dispatchClientBail,
  useClientContext,
  useClientRoutes,
  useNavigate,
} from "@host/client-sdk";
import type { TaskItem, TaskState } from "./contract.d.ts";

type FilterKind = "open" | "done" | "all";

const FILTERS: ReadonlyArray<{
  readonly id: FilterKind;
  readonly label: string;
}> = [
  { id: "open", label: "任务" },
  { id: "done", label: "已完成" },
  { id: "all", label: "全部任务" },
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      typeof data.error === "string" && data.error.length > 0
        ? data.error
        : `请求失败 (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function FilterIcon({ id }: { readonly id: FilterKind }) {
  if (id === "open") return <ListTodo className="size-4" aria-hidden="true" />;
  if (id === "done")
    return <CheckCheck className="size-4" aria-hidden="true" />;
  return <Circle className="size-4" aria-hidden="true" />;
}

function TodoWorkspacePage() {
  const clientCtx = useClientContext();
  const routes = useClientRoutes();
  const navigate = useNavigate();

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterKind>("open");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNotes, setEditNotes] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await requestJson<{ tasks: TaskItem[] }>(
        "/api/app/todo-core/tasks",
      );
      setTasks(data.tasks ?? []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  useEffect(() => {
    if (selectedTask) {
      setEditTitle(selectedTask.title);
      setEditNotes(selectedTask.notes);
    }
  }, [selectedTask?.id, selectedTask?.title, selectedTask?.notes]);

  const counts = useMemo(() => {
    let open = 0;
    let done = 0;
    for (const task of tasks) {
      if (task.state === "done") done += 1;
      else open += 1;
    }
    return { open, done, all: tasks.length };
  }, [tasks]);

  const visibleTasks = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return tasks.filter((task) => {
      if (filter !== "all" && task.state !== filter) return false;
      if (!keyword) return true;
      return (
        task.title.toLowerCase().includes(keyword) ||
        task.notes.toLowerCase().includes(keyword)
      );
    });
  }, [tasks, filter, search]);

  const extraRoutes = useMemo(
    () => routes.filter((route) => route.path !== "/" && route.navLabel),
    [routes],
  );

  const handleAddTask = async (event: FormEvent) => {
    event.preventDefault();
    const submitted = draft;
    const title = submitted.trim();
    if (!title || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson<{ task: TaskItem }>("/api/app/todo-core/tasks", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      setDraft((current) => (current === submitted ? "" : current));
      if (filter === "done") {
        setFilter("open");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleTransition = async (task: TaskItem, nextState: TaskState) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const meta: Record<string, unknown> = {};
      const verdict = await dispatchClientBail(
        clientCtx,
        "todo:before-transition",
        { task, nextState, meta },
      );
      if (verdict === false) {
        setError("状态流转已被扩展规则阻止");
        return;
      }
      if (typeof verdict === "string" && verdict.length > 0) {
        setError(verdict);
        return;
      }
      await requestJson<{ task: TaskItem }>(
        `/api/app/todo-core/tasks/${encodeURIComponent(task.id)}/transition`,
        {
          method: "POST",
          body: JSON.stringify({ nextState, meta }),
        },
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveDetail = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedTask || busy) return;
    const nextTitle = editTitle.trim();
    if (!nextTitle) {
      setError("任务标题不能为空");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await requestJson<{ task: TaskItem }>(
        `/api/app/todo-core/tasks/${encodeURIComponent(selectedTask.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ title: nextTitle, notes: editNotes }),
        },
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(
        `/api/app/todo-core/tasks/${encodeURIComponent(taskId)}`,
        { method: "DELETE" },
      );
      if (selectedTaskId === taskId) {
        setSelectedTaskId(null);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeFilterLabel =
    FILTERS.find((item) => item.id === filter)?.label ?? "任务";

  return (
    <div
      data-todo-core="true"
      className="flex min-h-0 flex-1 flex-col bg-canvas text-ink md:flex-row"
    >
      {/* Unified responsive navigation: top bar on mobile, left sidebar on desktop */}
      <aside className="flex w-full shrink-0 flex-col gap-2.5 border-b border-line bg-sidebar p-3 md:w-60 md:gap-0 md:border-r md:border-b-0">
        <div className="relative md:mb-3">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索任务"
            aria-label="搜索任务"
            data-todo-search-input="true"
            className="min-h-11 w-full rounded-md border border-line bg-surface py-2 pr-3 pl-9 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent md:min-h-10"
          />
        </div>

        <nav
          aria-label="任务筛选"
          className="flex gap-1.5 md:flex-col md:gap-1"
        >
          {FILTERS.map((item) => {
            const active = filter === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-todo-filter={item.id}
                onClick={() => setFilter(item.id)}
                className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-2 text-xs transition-colors md:min-h-10 md:w-full md:flex-none md:justify-between md:px-3 md:text-sm ${
                  active
                    ? "bg-accent-soft font-medium text-accent"
                    : "border border-line bg-surface text-ink hover:bg-line/50 md:border-transparent md:bg-transparent"
                }`}
              >
                <span className="flex items-center gap-2">
                  <FilterIcon id={item.id} />
                  <span>{item.label}</span>
                </span>
                <span className="text-xs tabular-nums text-muted">
                  {counts[item.id]}
                </span>
              </button>
            );
          })}
        </nav>

        {extraRoutes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2 md:mt-4 md:block md:pt-3">
            <div className="hidden px-3 pb-1.5 text-[11px] font-medium text-muted md:block">
              扩展视图
            </div>
            <nav
              aria-label="扩展视图"
              className="flex flex-wrap gap-1.5 md:flex-col md:gap-1"
            >
              {extraRoutes.map((route) => (
                <button
                  key={route.path}
                  type="button"
                  onClick={() => navigate(route.path)}
                  className="flex min-h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors hover:bg-line/50 md:min-h-10 md:w-full md:border-transparent md:bg-transparent"
                >
                  <Compass className="size-4 text-muted" aria-hidden="true" />
                  <span className="truncate">{route.navLabel}</span>
                </button>
              ))}
            </nav>
          </div>
        )}

        <div className="md:mt-4">
          <Slot
            name="todo.sidebar.sections"
            props={{ tasks, filter, refresh }}
            className="space-y-2"
          />
        </div>
      </aside>

      {/* Main task list workspace */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 px-6 pt-6 pb-3">
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            {activeFilterLabel}
          </h1>
          <Slot
            name="todo.header.actions"
            props={{ tasks, filter, refresh }}
            className="flex items-center gap-2"
          />
        </div>

        <div className="px-6">
          <Slot
            name="todo.list.banner"
            props={{ tasks, filter, refresh }}
            className="mb-3 space-y-2"
          />
          {error && (
            <div
              role="alert"
              data-todo-error="true"
              className="mb-3 rounded-md border border-danger/25 bg-danger/5 px-3 py-2 text-sm text-danger"
            >
              {error}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
          {loading ? (
            <p className="py-6 text-sm text-muted">正在加载任务…</p>
          ) : visibleTasks.length === 0 ? (
            <div
              data-todo-empty="true"
              className="rounded-lg border border-dashed border-line bg-surface/60 px-4 py-8 text-center text-sm text-muted"
            >
              {search.trim()
                ? "没有匹配当前搜索条件的任务"
                : filter === "done"
                  ? "暂无已完成任务"
                  : "暂无待办任务，在下方添加第一条任务"}
            </div>
          ) : (
            <ul data-todo-list="true" className="space-y-1.5">
              {visibleTasks.map((task) => {
                const isDone = task.state === "done";
                const isSelected = task.id === selectedTaskId;
                return (
                  <li
                    key={task.id}
                    data-todo-item={task.id}
                    data-todo-state={task.state}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors md:gap-3 md:px-3.5 md:py-2.5 ${
                      isSelected
                        ? "border-accent/40 bg-accent-soft/35"
                        : "border-line bg-surface hover:border-line/80"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      data-todo-toggle={task.id}
                      aria-label={
                        isDone
                          ? `重新打开：${task.title}`
                          : `完成任务：${task.title}`
                      }
                      onClick={() =>
                        void handleTransition(task, isDone ? "open" : "done")
                      }
                      className="flex size-11 shrink-0 items-center justify-center rounded-full md:size-7"
                    >
                      <span
                        className={`flex size-5 items-center justify-center rounded-full border transition-colors ${
                          isDone
                            ? "border-accent bg-accent text-surface"
                            : "border-muted/60 bg-surface text-transparent hover:border-accent"
                        }`}
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                      </span>
                    </button>

                    <button
                      type="button"
                      data-todo-select={task.id}
                      onClick={() => setSelectedTaskId(task.id)}
                      className="min-h-11 min-w-0 flex-1 py-1 text-left md:min-h-0 md:py-0"
                    >
                      <div
                        className={`truncate text-sm ${
                          isDone ? "text-muted line-through" : "text-ink"
                        }`}
                      >
                        {task.title}
                      </div>
                      {task.notes && (
                        <div className="mt-0.5 truncate text-xs text-muted">
                          {task.notes}
                        </div>
                      )}
                    </button>

                    <Slot
                      name="todo.item.badges"
                      props={{ task, refresh }}
                      className="flex shrink-0 flex-wrap items-center gap-1.5"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Persistent bottom quick-add bar */}
        <form
          onSubmit={(e) => void handleAddTask(e)}
          className="border-t border-line bg-surface px-6 py-3"
        >
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Plus
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-accent"
                aria-hidden="true"
              />
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="添加任务"
                aria-label="添加任务"
                data-todo-add-input="true"
                className="min-h-11 w-full rounded-md border border-line bg-canvas py-2.5 pr-3 pl-9 text-sm text-ink outline-none focus:border-accent focus:bg-surface focus:ring-1 focus:ring-accent md:min-h-10"
              />
            </div>
            <Button
              type="submit"
              disabled={busy || !draft.trim()}
              data-todo-add-submit="true"
              className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-surface transition-colors hover:bg-accent/90 disabled:opacity-45 md:min-h-10"
            >
              添加
            </Button>
          </div>
        </form>
      </main>

      {/* Task detail panel */}
      {selectedTask && (
        <aside
          data-todo-detail={selectedTask.id}
          aria-label="任务详情"
          className="flex w-full shrink-0 flex-col border-t border-line bg-surface md:w-[340px] md:border-t-0 md:border-l"
        >
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
            <h2 className="text-sm font-semibold text-ink">任务详情</h2>
            <button
              type="button"
              aria-label="关闭任务详情"
              onClick={() => setSelectedTaskId(null)}
              className="inline-flex size-11 items-center justify-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink md:size-8"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <form
            onSubmit={(e) => void handleSaveDetail(e)}
            className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
          >
            <div className="space-y-1.5">
              <label
                htmlFor="todo-detail-title"
                className="block text-xs font-medium text-muted"
              >
                标题
              </label>
              <input
                id="todo-detail-title"
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="min-h-11 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent md:min-h-10"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="todo-detail-notes"
                className="block text-xs font-medium text-muted"
              >
                备注
              </label>
              <textarea
                id="todo-detail-notes"
                rows={4}
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="补充任务说明或备注"
                className="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={busy || !editTitle.trim()}
                data-todo-detail-save="true"
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-3.5 text-sm font-medium text-surface transition-colors hover:bg-accent/90 disabled:opacity-45 md:min-h-9"
              >
                保存更改
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() =>
                  void handleTransition(
                    selectedTask,
                    selectedTask.state === "done" ? "open" : "done",
                  )
                }
                className="inline-flex min-h-11 items-center justify-center rounded-md border border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-canvas md:min-h-9"
              >
                {selectedTask.state === "done" ? "重新打开" : "标记完成"}
              </Button>
            </div>

            <div className="border-t border-line pt-4">
              <Slot
                name="todo.item.detail"
                props={{ task: selectedTask, refresh }}
                className="space-y-3"
              />
            </div>

            <div className="mt-auto border-t border-line pt-3">
              <button
                type="button"
                disabled={busy}
                data-todo-detail-delete="true"
                onClick={() => void handleDeleteTask(selectedTask.id)}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10 md:min-h-9"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                <span>删除任务</span>
              </button>
            </div>
          </form>
        </aside>
      )}
    </div>
  );
}

export default function apply(ctx: Context): void {
  ctx.router.registerPage({
    path: "/",
    navLabel: "任务",
    order: 0,
    component: TodoWorkspacePage,
  });
}
