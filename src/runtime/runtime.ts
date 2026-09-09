import { fork, type ChildProcess } from "node:child_process";
import type { RuntimeTarget } from "../release/types.js";

export class Runtime {
  private child: ChildProcess;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private sequence = 0;
  private closing = false;
  private exited = false;
  private exitPromise: Promise<void>;
  onFailure?: () => void;
  readonly ready: Promise<void>;
  get pid() {
    return this.child.pid;
  }
  private constructor(
    target: RuntimeTarget,
    private timeout = 5000,
    entry?: URL,
  ) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const plugins = target.plugins?.length
      ? target.plugins
      : [
          {
            pluginId: target.pluginId,
            entry: target.entry,
            service: target.service,
            bundle: target.bundle,
            role: "workflow" as const,
          },
        ];
    this.child = fork(
      entry ?? new URL(`./child.${extension}`, import.meta.url),
      [
        JSON.stringify({
          plugins: plugins.map((plugin) => ({
            pluginId: plugin.pluginId,
            entry: plugin.entry,
            service: plugin.service,
            modules:
              plugin.bundle?.outputs ??
              (plugin.pluginId === target.pluginId
                ? target.bundle?.outputs
                : undefined),
            role: plugin.role,
          })),
        }),
      ],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: Object.fromEntries(
          ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"].flatMap((key) =>
            process.env[key] ? [[key, process.env[key]!]] : [],
          ),
        ),
        ...{ windowsHide: true },
        execArgv: [
          "--max-old-space-size=128",
          "--experimental-vm-modules",
          ...(extension === "ts" ? ["--import", "tsx"] : []),
        ],
      },
    );
    let diagnostics = "";
    this.child.stderr?.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk).slice(-2000);
    });
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timer = setTimeout(() => {
      readyReject(new Error("运行环境启动超时"));
      this.child.kill("SIGKILL");
    }, timeout);
    const fail = (error: Error) => {
      clearTimeout(timer);
      readyReject(error);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
    };
    this.child.on("error", fail);
    this.exitPromise = new Promise((resolve) =>
      this.child.once("close", () => {
        this.exited = true;
        fail(new Error(`运行环境已退出 ${diagnostics}`));
        resolve();
        if (!this.closing) this.onFailure?.();
      }),
    );
    this.child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as {
        ready?: boolean;
        id: number;
        error?: string;
        value?: unknown;
      };
      if (message.ready) {
        clearTimeout(timer);
        readyResolve();
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    });
  }
  static async start(target: RuntimeTarget, timeout = 5000, entry?: URL) {
    const runtime = new Runtime(target, timeout, entry);
    try {
      await runtime.ready;
      return runtime;
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  invoke<T>(method: string, data?: unknown, pluginId?: string): Promise<T> {
    if (this.exited || this.closing)
      return Promise.reject(new Error("运行环境不可用"));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("插件执行超时"));
        this.child.kill("SIGKILL");
      }, this.timeout);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.child.send({ id, method, data, pluginId }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async close() {
    this.closing = true;
    if (this.exited) return;
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 500);
    if (this.child.connected) this.child.send({ method: "close" }, () => {});
    else this.child.kill("SIGKILL");
    await this.exitPromise;
    clearTimeout(timer);
  }
}
