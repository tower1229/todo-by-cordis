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
  async function recover(restore = false, versionId?: string) {
    if (!composition || busy) return;
    setBusy(true);
    setError("");
    try {
      if (restore)
        await sendOperation("/runtime/restore", {
          compositionRevision: composition.revision,
          ...(versionId ? { versionId } : {}),
        });
      else await api("/runtime/retry", {});
      await refreshed();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function setMemberEnabled(pluginId: string, enabled: boolean) {
    if (!composition || busy) return;
    setBusy(true);
    setError("");
    try {
      await sendOperation("/composition/members", {
        compositionRevision: composition.revision,
        versionId: composition.versionId,
        pluginId,
        enabled,
      });
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
      {composition && composition.members.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted">组合成员</p>
          <ul className="divide-y divide-line border-y border-line">
            {composition.members.map((member) => {
              const isWorkflow = member.role === "workflow" && member.enabled;
              return (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={member.pluginId}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{member.pluginId}</p>
                    <p className="text-xs text-muted">
                      {member.enabled ? "已启用" : "已停用"}
                    </p>
                  </div>
                  <Button
                    disabled={
                      busy ||
                      composition.status !== "ready" ||
                      isWorkflow
                    }
                    onClick={() =>
                      setMemberEnabled(member.pluginId, !member.enabled)
                    }
                  >
                    {busy && <Spinner />}
                    {member.enabled ? "停用" : "启用"}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {composition?.status !== "ready" && (
        <Button disabled={busy || !composition} onClick={() => recover()}>
          {busy && <Spinner />}重试运行环境
        </Button>
      )}
      {composition?.recovery && (
        <p role="status" className="text-xs leading-5 text-muted">
          最近一次发布在开放写入前失败，已补偿回版本{" "}
          {composition.recovery.restoredVersionId.slice(0, 8)}…；原因：
          {composition.recovery.reason}
        </p>
      )}
      {composition && composition.previousVersionId && (
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted">
            撤回版本，保留已有任务和字段。
          </p>
          <Button disabled={busy} onClick={() => recover(true)}>
            {busy && <Spinner />}撤回上个版本
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
                  {item.name}
                  <span className="ml-2 text-xs text-muted">
                    版本 {item.id}
                  </span>
                </p>
                <time className="mt-1 block text-xs text-muted">
                  {new Date(item.createdAt).toLocaleString("zh-CN")}
                </time>
                {item.versionId !== composition.versionId && (
                  <Button
                    disabled={busy}
                    onClick={() => recover(true, item.versionId)}
                  >
                    恢复此版本
                  </Button>
                )}
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
