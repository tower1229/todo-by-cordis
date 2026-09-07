import { useState } from "react";
import type { Composition } from "../shared/contracts.js";
import { api, errorMessage, sendOperation } from "./api.js";
import { Button, ErrorMessage, Spinner } from "./ui.js";
export function WorkspacePanel({
  composition,
  refreshed,
}: {
  composition?: Composition;
  refreshed: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function recover(restore = false) {
    if (!composition || busy) return;
    setBusy(true);
    setError("");
    try {
      if (restore)
        await sendOperation("/runtime/restore", {
          compositionRevision: composition.revision,
        });
      else await api("/runtime/retry", {});
      await refreshed();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-7 overflow-y-auto p-5 text-sm">
      <dl className="space-y-4">
        <div className="flex justify-between">
          <dt className="text-muted">数据</dt>
          <dd>保存在本机</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">运行状态</dt>
          <dd>
            {composition
              ? {
                  ready: "正常",
                  recovering: "正在恢复",
                  unavailable: "不可用",
                }[composition.status]
              : "正在读取"}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="shrink-0 text-muted">当前流程</dt>
          <dd>
            {composition?.workflow.id === "default"
              ? "默认流程"
              : composition?.workflow.name}
          </dd>
        </div>
      </dl>
      {composition?.status !== "ready" && (
        <Button disabled={busy || !composition} onClick={() => recover()}>
          {busy && <Spinner />}重试运行环境
        </Button>
      )}
      {composition && composition.workflow.id !== "default" && (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted">
            恢复默认完成方式，保留已有任务和字段。
          </p>
          <Button disabled={busy} onClick={() => recover(true)}>
            {busy && <Spinner />}恢复默认流程
          </Button>
        </div>
      )}
      <ErrorMessage message={error} />
      <details className="border-t border-line pt-4">
        <summary className="cursor-pointer font-medium">版本记录</summary>
        {!composition?.history.length ? (
          <p className="py-5 text-muted">暂无版本变更</p>
        ) : (
          <ol className="divide-y divide-line">
            {composition.history.map((item) => (
              <li className="py-4" key={item.id}>
                <p>
                  {item.workflowId === "default" ? "默认流程" : "复盘流程"}
                  <span className="ml-2 text-xs text-muted">
                    版本 {item.id}
                  </span>
                </p>
                <time className="mt-1 block text-xs text-muted">
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </time>
              </li>
            ))}
          </ol>
        )}
        {composition && (
          <p className="break-all text-xs leading-5 text-muted">
            构建 {composition.buildHash}
          </p>
        )}
      </details>
    </div>
  );
}
