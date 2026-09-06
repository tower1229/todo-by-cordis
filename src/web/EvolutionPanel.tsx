import type { Composition } from "../shared/contracts.js";
import { Assistant } from "./Assistant.js";
import { Icon } from "./Icon.js";
export function EvolutionPanel({
  composition,
  busy,
  toggleFlow,
  assistantState,
}: {
  composition?: Composition;
  busy: boolean;
  toggleFlow: () => void;
  assistantState: "idle" | "working" | "success" | "error";
}) {
  return (
    <>
      <div className="companion">
        <span className="eyebrow">一点新的可能</span>
        <Assistant state={assistantState} />
        <h2>你的待办，也可以成长。</h2>
        <p>
          让工具慢慢靠近你的习惯。
          <br />
          从一个小小的改变开始。
        </p>
      </div>
      <section className="evolution">
        <div className="section-title">
          <span>
            <Icon name="evolve" />
            正在使用的流程
          </span>
          <span className="version">
            v{composition?.workflow.version ?? "1.0.0"}
          </span>
        </div>
        <h3>{composition?.workflow.name ?? "轻快完成"}</h3>
        <p>
          {composition?.workflow.fields.length
            ? "完成之前，多留下一句属于自己的收获。"
            : "记录、行动、完成。把注意力留给事情本身。"}
        </p>
        <div className="flow-preview">
          <div>
            <span>现在</span>
            <p>
              {composition?.workflow.fields.length
                ? "行动 → 复盘 → 完成"
                : "行动 → 完成"}
            </p>
          </div>
          <Icon name="arrow" />
          <div>
            <span>改变后</span>
            <p>
              {composition?.workflow.fields.length
                ? "行动 → 完成"
                : "行动 → 复盘 → 完成"}
            </p>
          </div>
        </div>
        <button
          className="evolve-button"
          onClick={toggleFlow}
          disabled={busy || !composition}
        >
          {busy
            ? "正在准备新流程…"
            : composition?.workflow.fields.length
              ? "恢复轻快完成"
              : "体验复盘流程"}
          <Icon name="arrow" />
        </button>
        <div className="demo-note">
          <span>手写演示插件</span>
          <p>这是真实的流程切换。AI 自主生成将在下一阶段接入。</p>
        </div>
      </section>
      <section className="history">
        <h3>
          成长足迹 <span>{composition?.history.length ?? 0}</span>
        </h3>
        {!composition?.history.length ? (
          <p className="history-empty">第一次改变，正等着发生。</p>
        ) : (
          composition.history.slice(0, 5).map((item) => (
            <div className="history-item" key={item.id}>
              <span className="history-dot" />
              <div>
                <strong>
                  {item.workflowId === "review"
                    ? "学会了完成前复盘"
                    : "回到了轻快完成"}
                </strong>
                <small>
                  {new Date(item.createdAt).toLocaleString("zh-CN", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  · 版本 {item.id}
                </small>
              </div>
              <Icon name="check" />
            </div>
          ))
        )}
      </section>
    </>
  );
}
