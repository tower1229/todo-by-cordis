import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { Menu } from "@base-ui/react/menu";
import {
  Check,
  CheckCheck,
  Circle,
  ListTodo,
  MoreHorizontal,
  Plus,
  Search,
  Settings2,
  Sparkles,
  X,
} from "lucide-react";
import type { Composition, Task, TaskList } from "../shared/contracts.js";
import { api, errorMessage, sendCommand } from "./api.js";
import { Editor } from "./TaskEditor.js";
import { InputForm, type ActionForm } from "./ActionForm.js";
import { Button, ErrorMessage, Sheet, Spinner } from "./ui.js";
import { useAssistant } from "./useAssistant.js";
import { AssistantPanel } from "./AssistantPanel.js";
import { WorkspacePanel } from "./WorkspacePanel.js";
import "./style.css";

const filters = [
  { id: "open", label: "任务", icon: ListTodo },
  { id: "done", label: "已完成", icon: CheckCheck },
  { id: "all", label: "全部任务", icon: Circle },
] as const;
type Category = (typeof filters)[number]["id"];
type Panel =
  | { kind: "task"; task: Task }
  | { kind: "action"; form: ActionForm }
  | { kind: "assistant" }
  | { kind: "workspace" };

function App() {
  const [composition, setComposition] = useState<Composition>();
  const [list, setList] = useState<TaskList>();
  const [category, setCategory] = useState<Category>("open");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [panel, setPanel] = useState<Panel>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState<Task>();
  const [seenMessage, setSeenMessage] = useState(
    () => localStorage.getItem("assistant-seen") ?? "",
  );
  const [draft, setDraft] = useState(
    () => localStorage.getItem("quick-task-draft") ?? "",
  );
  const composing = useRef(false);
  const latest = useRef(0);
  const locked = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const aiTrigger = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    const request = ++latest.current;
    const [pages, next] = await Promise.all([
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
    setComposition(next);
    setList({ ...pages[0], tasks: pages.flatMap((page) => page.tasks) });
  }, [category, search, offset]);
  const refreshAfterWrite = useCallback(async () => {
    try {
      await refresh();
    } catch (error) {
      setError(`已保存，但列表暂时无法刷新：${errorMessage(error)}`);
    }
  }, [refresh]);
  const assistant = useAssistant(refreshAfterWrite);
  useEffect(() => {
    const timer = setTimeout(
      () => {
        void refresh().catch((error) => setError(errorMessage(error)));
      },
      search ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      latest.current++;
    };
  }, [refresh, search]);
  useEffect(() => {
    const onFocus = () => {
      void refresh().catch((error) => setError(errorMessage(error)));
      void assistant.observe();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, assistant.observe]);
  useEffect(() => {
    localStorage.setItem("quick-task-draft", draft);
  }, [draft]);
  useEffect(() => {
    // Old bookmarks now land on the task workspace, without a separate AI route.
    if (location.pathname === "/evolve") history.replaceState({}, "", "/");
    const back = () => setPanel(undefined);
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  function openPanel(
    next: Panel,
    trigger: HTMLElement | null = document.activeElement as HTMLElement,
  ) {
    returnFocus.current = trigger;
    setPanel(next);
  }
  async function write(operation: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorMessage(error));
      await refresh().catch(() => {});
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!composition || !draft.trim() || composing.current) return;
    await write(async () => {
      await sendCommand({
        type: "create",
        title: draft.trim(),
        compositionRevision: composition.revision,
      });
      setDraft("");
      if (category === "done" || search) {
        setCategory("open");
        setSearch("");
        setOffset(0);
      }
      await refreshAfterWrite();
      addInput.current?.focus();
    });
  }
  async function act(
    task: Task,
    action: { id: string; label: string },
    trigger: HTMLElement,
  ) {
    if (!composition) return;
    await write(async () => {
      const result = await sendCommand({
        type: "action",
        taskId: task.id,
        actionId: action.id,
        expectedRevision: task.revision,
        compositionRevision: composition.revision,
      });
      if (result.decision?.kind === "input-required")
        openPanel(
          {
            kind: "action",
            form: {
              task,
              actionId: action.id,
              label: action.label,
              fields: result.decision.fields,
              revision: composition.revision,
            },
          },
          trigger,
        );
      else await refreshAfterWrite();
    });
  }
  async function remove(task: Task) {
    if (!composition) return;
    const result = await sendCommand({
      type: "delete",
      taskId: task.id,
      expectedRevision: task.revision,
      compositionRevision: composition.revision,
    });
    setUndo(result.task);
    setPanel(undefined);
    await refreshAfterWrite();
  }
  const selectedFilter = filters.find((filter) => filter.id === category)!;
  const run = assistant.snapshot?.run;
  const messageId = run ? `${run.id}:${run.status}:${run.updatedAt}` : "";
  useEffect(() => {
    if (panel?.kind === "assistant" && messageId) {
      setSeenMessage(messageId);
      localStorage.setItem("assistant-seen", messageId);
    }
  }, [panel?.kind, messageId]);
  const notification =
    messageId !== seenMessage &&
    (run?.status === "awaiting-confirmation" ||
      run?.status === "awaiting-input" ||
      run?.status === "succeeded" ||
      run?.status === "failed");
  const navigation = (mobile = false) => (
    <nav
      className={mobile ? "flex gap-1 md:hidden" : "space-y-1"}
      aria-label="任务列表"
    >
      {filters.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          variant="ghost"
          aria-label={label}
          aria-pressed={category === id}
          className={`${mobile ? "flex-1 px-2 text-xs" : "w-full justify-start gap-3 px-3"} ${category === id ? "bg-accent-soft text-accent hover:bg-accent-soft" : "text-muted"}`}
          onClick={() => {
            if (id === category) return;
            latest.current++;
            setList(undefined);
            setCategory(id);
            setOffset(0);
          }}
        >
          {!mobile && <Icon className="size-[18px]" strokeWidth={1.6} />}
          <span>{label}</span>
          {!mobile && list && (
            <span className="ml-auto text-xs tabular-nums">
              {id === "all"
                ? list.counts.open + list.counts.done
                : list.counts[id]}
            </span>
          )}
        </Button>
      ))}
    </nav>
  );
  const searchField = (mobile = false) => (
    <div
      className={`flex h-10 items-center gap-2 rounded-md border border-line bg-surface px-3 ${mobile ? "md:hidden" : ""}`}
    >
      <Search className="size-4 shrink-0 text-muted" strokeWidth={1.6} />
      <input
        aria-label="搜索任务"
        placeholder="搜索"
        className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        value={search}
        onChange={(e) => {
          latest.current++;
          setSearch(e.target.value);
          setOffset(0);
        }}
      />
      {search && (
        <button
          aria-label="清除搜索"
          className="rounded p-1 text-muted"
          onClick={() => {
            setSearch("");
            setOffset(0);
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
  const panelTitle =
    panel?.kind === "task"
      ? "任务详情"
      : panel?.kind === "action"
        ? panel.form.label
        : panel?.kind === "assistant"
          ? "AI 助手"
          : "工作区设置";
  return (
    <div className="flex h-dvh min-h-0 bg-canvas text-ink">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-sidebar px-4 py-6 md:flex">
        <a
          href="/"
          className="mb-8 flex w-fit items-center gap-2.5 px-2 text-[17px] font-semibold tracking-tight"
        >
          <Check className="size-6 text-accent" strokeWidth={2.5} />
          哆啦AI梦
        </a>
        {searchField()}
        <div className="mt-5">{navigation()}</div>
      </aside>
      <main
        className={`flex min-w-0 flex-1 flex-col ${panel ? "xl:pr-[400px]" : ""}`}
      >
        <header className="flex shrink-0 items-center justify-between px-5 pb-5 pt-8 md:px-10 md:pt-10">
          <h1 className="flex items-center gap-3 text-[26px] font-semibold tracking-tight">
            <selectedFilter.icon
              className="size-6 text-accent"
              strokeWidth={1.6}
            />
            {search ? "搜索结果" : selectedFilter.label}
          </h1>
          <Menu.Root>
            <Menu.Trigger className="btn btn-icon" aria-label="更多选项">
              <MoreHorizontal className="size-5" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner align="end" sideOffset={6} className="z-40">
                <Menu.Popup className="menu-popup">
                  <Menu.Item
                    className="menu-item"
                    onClick={() => openPanel({ kind: "workspace" })}
                  >
                    <Settings2 className="size-4" />
                    工作区设置
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </header>
        <div className="space-y-3 px-5 pb-4 md:hidden">
          {searchField(true)}
          {navigation(true)}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 md:px-10">
          <div className="mx-auto max-w-4xl pb-6">
            {error && (
              <div className="mb-4 space-y-2">
                <ErrorMessage message={error} />
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError("");
                    void refresh().catch((error) =>
                      setError(errorMessage(error)),
                    );
                  }}
                >
                  重试
                </Button>
              </div>
            )}
            {composition && composition.status !== "ready" && (
              <div
                role="status"
                className="mb-4 flex items-center justify-between gap-3 rounded-md bg-danger/5 px-3 py-2 text-sm text-danger"
              >
                <span>任务流程暂不可用</span>
                <Button
                  variant="ghost"
                  onClick={() => openPanel({ kind: "workspace" })}
                >
                  恢复
                </Button>
              </div>
            )}
            {!list ? (
              <div
                aria-label="正在读取任务"
                role="status"
                className="space-y-2"
              >
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="h-14 animate-pulse rounded-md bg-line/50 motion-reduce:animate-none"
                  />
                ))}
              </div>
            ) : list.tasks.length === 0 ? (
              <div className="flex min-h-[35vh] flex-col items-center justify-center gap-4 text-muted">
                <selectedFilter.icon
                  className="size-10 opacity-45"
                  strokeWidth={1}
                />
                <p className="text-sm">
                  {search
                    ? "没有匹配的任务"
                    : category === "done"
                      ? "暂无已完成任务"
                      : "暂无任务"}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                {list.tasks.map((task) => {
                  const definition = composition?.workflow;
                  const actions =
                    definition?.actions.filter((action) =>
                      action.from.includes(task.state),
                    ) ?? [];
                  const done =
                    definition?.states[task.state]?.category === "done";
                  return (
                    <article
                      key={task.id}
                      className="group flex min-h-16 items-center border-b border-line px-2 last:border-0 hover:bg-canvas/60"
                    >
                      <button
                        className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted hover:text-accent disabled:opacity-40"
                        aria-label={`${actions[0]?.label ?? "操作"} ${task.title}`}
                        disabled={
                          busy ||
                          !actions.length ||
                          composition?.status !== "ready"
                        }
                        onClick={(e) => act(task, actions[0], e.currentTarget)}
                      >
                        <span
                          className={`flex size-[19px] items-center justify-center rounded-full border ${done ? "border-accent bg-accent text-surface" : "border-muted/65 group-hover:border-accent"}`}
                        >
                          {done && (
                            <Check className="size-3" strokeWidth={2.3} />
                          )}
                        </span>
                      </button>
                      <button
                        className="min-w-0 flex-1 py-4 pl-1 pr-3 text-left"
                        aria-label={`编辑 ${task.title}`}
                        onClick={(e) =>
                          openPanel({ kind: "task", task }, e.currentTarget)
                        }
                      >
                        <span
                          className={`block break-words text-[14px] leading-6 ${done ? "text-muted line-through" : ""}`}
                        >
                          {task.title}
                        </span>
                        {task.description && (
                          <span className="mt-0.5 block truncate text-xs text-muted">
                            {task.description}
                          </span>
                        )}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
            {list && list.tasks.length < list.total && (
              <Button
                variant="ghost"
                className="mt-4 w-full"
                onClick={() => setOffset(list.tasks.length)}
              >
                加载更多
              </Button>
            )}
          </div>
        </div>
        <div className="shrink-0 px-5 pb-5 pt-2 md:px-10 md:pb-8">
          <form
            onSubmit={add}
            className="mx-auto flex min-h-14 max-w-4xl items-center gap-3 rounded-lg border border-line bg-surface px-4 focus-within:border-accent"
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
          >
            <Plus className="size-5 shrink-0 text-accent" strokeWidth={1.6} />
            <input
              ref={addInput}
              aria-label="添加任务"
              placeholder="添加任务"
              className="min-w-0 flex-1 bg-transparent py-4 text-sm outline-none"
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy || !composition}
            />
            {draft.trim() && (
              <Button
                type="submit"
                variant="ghost"
                className="px-2 text-accent"
                disabled={busy || !composition}
              >
                {busy ? <Spinner /> : "添加"}
              </Button>
            )}
          </form>
        </div>
      </main>
      <Button
        ref={aiTrigger}
        variant="secondary"
        className={`fixed bottom-[96px] right-5 z-20 size-11 rounded-full border-line bg-surface p-0 shadow-sm md:bottom-28 md:right-10 ${panel ? "hidden" : ""}`}
        aria-label="打开 AI 助手"
        title="AI 助手"
        onClick={() => {
          openPanel({ kind: "assistant" }, aiTrigger.current);
          void assistant.observe();
        }}
      >
        {assistant.working ? (
          <Spinner label="AI 正在处理" />
        ) : (
          <Sparkles className="size-[19px] text-accent" strokeWidth={1.6} />
        )}
        {notification && (
          <span className="absolute right-0 top-0 size-2 rounded-full bg-accent">
            <span className="sr-only">AI 有新消息</span>
          </span>
        )}
      </Button>
      <Sheet
        open={Boolean(panel)}
        close={() => setPanel(undefined)}
        title={panelTitle}
        returnFocus={returnFocus.current}
        wide={panel?.kind === "assistant"}
        action={
          panel &&
          panel.kind !== "assistant" && (
            <Button
              variant="icon"
              aria-label="打开 AI 助手"
              onClick={() => {
                openPanel({ kind: "assistant" }, aiTrigger.current);
                void assistant.observe();
              }}
            >
              <Sparkles className="size-[18px] text-accent" />
            </Button>
          )
        }
      >
        {panel?.kind === "task" && (
          <Editor
            key={panel.task.id}
            task={panel.task}
            revision={composition?.revision ?? 1}
            fields={composition?.retainedFields ?? []}
            saved={refreshAfterWrite}
            close={() => setPanel(undefined)}
            remove={() => remove(panel.task)}
          />
        )}
        {panel?.kind === "action" && (
          <InputForm
            key={`${panel.form.task.id}:${panel.form.revision}`}
            form={panel.form}
            done={refreshAfterWrite}
            cancel={() => setPanel(undefined)}
          />
        )}
        {panel?.kind === "assistant" && (
          <AssistantPanel controller={assistant} />
        )}
        {panel?.kind === "workspace" && (
          <WorkspacePanel composition={composition} refreshed={refresh} />
        )}
      </Sheet>
      {undo && (
        <div
          role="status"
          className="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-24px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-sm shadow-lg"
        >
          <span className="shrink-0">已删除任务</span>
          <Button
            variant="ghost"
            disabled={busy}
            className="text-accent"
            onClick={() =>
              write(async () => {
                if (!composition) return;
                await sendCommand({
                  type: "restore",
                  taskId: undo.id,
                  expectedRevision: undo.revision,
                  compositionRevision: composition.revision,
                });
                setUndo(undefined);
                await refreshAfterWrite();
              })
            }
          >
            撤销删除
          </Button>
          <Button
            variant="icon"
            aria-label="关闭撤销提示"
            onClick={() => setUndo(undefined)}
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
