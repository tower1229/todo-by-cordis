import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactKey, validateAndSortComposition } from "./topology.js";
import type {
  ActiveClientComposition,
  AppResponse,
  CompositionSnapshot,
  CompositionTopology,
  HttpDispatchInput,
  PluginArtifact,
  RuntimeHealth,
  ServerCordisRuntime,
} from "./types.js";

export interface SupervisedCordisRuntimeOptions {
  readonly dbPath: string;
  readonly workDir: string;
  readonly startTimeoutMs?: number;
  readonly applyTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

class WorkerProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingRpc>();
  private seq = 0;
  private closing = false;
  private exited = false;
  private readonly exitPromise: Promise<void>;
  readonly ready: Promise<void>;
  onUnexpectedExit?: (diagnostics: string) => void;

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get isAlive(): boolean {
    return !this.exited && !this.closing;
  }

  private constructor(dbPath: string, startTimeoutMs: number) {
    const isTs = import.meta.url.endsWith(".ts");
    const targetUrl = new URL(
      `./worker-child.${isTs ? "ts" : "js"}`,
      import.meta.url,
    );

    this.child = fork(targetUrl, [dbPath], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      execArgv: isTs ? ["--import", "tsx"] : [],
    });

    let diagnostics = "";
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-4000);
    });

    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const startTimer = setTimeout(() => {
      readyReject(
        new Error(`Worker subprocess start timeout after ${startTimeoutMs}ms`),
      );
      this.child.kill("SIGKILL");
    }, startTimeoutMs);

    const failAll = (error: Error) => {
      clearTimeout(startTimer);
      readyReject(error);
      for (const req of this.pending.values()) {
        clearTimeout(req.timer);
        req.reject(error);
      }
      this.pending.clear();
    };

    this.child.on("error", failAll);

    this.exitPromise = new Promise((resolve) => {
      this.child.once("close", () => {
        this.exited = true;
        const msg = diagnostics
          ? `Worker subprocess exited unexpectedly: ${diagnostics}`
          : "Worker subprocess exited unexpectedly";
        failAll(new Error(msg));
        resolve();
        if (!this.closing) {
          this.onUnexpectedExit?.(diagnostics);
        }
      });
    });

    this.child.on("message", (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as {
        ready?: boolean;
        id?: number;
        error?: string;
        value?: unknown;
      };
      if (msg.ready) {
        clearTimeout(startTimer);
        readyResolve();
        return;
      }
      if (typeof msg.id !== "number") return;
      const req = this.pending.get(msg.id);
      if (!req) return;
      clearTimeout(req.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        req.reject(new Error(msg.error));
      } else {
        req.resolve(msg.value);
      }
    });
  }

  static async spawn(
    dbPath: string,
    startTimeoutMs: number,
  ): Promise<WorkerProcess> {
    const worker = new WorkerProcess(dbPath, startTimeoutMs);
    try {
      await worker.ready;
      return worker;
    } catch (error) {
      await worker.kill();
      throw error;
    }
  }

  call<T>(method: string, payload: unknown, timeoutMs: number): Promise<T> {
    if (!this.isAlive) {
      return Promise.reject(new Error("Worker subprocess is not available"));
    }
    return new Promise<T>((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.closing = true;
        this.child.kill("SIGKILL");
        reject(new Error(`Worker RPC "${method}" timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      this.child.send({ id, method, payload }, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async kill(): Promise<void> {
    this.closing = true;
    if (this.exited) return;
    this.child.kill("SIGKILL");
    await this.exitPromise;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.exited) return;
    const forceTimer = setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 500);
    if (this.child.connected) {
      this.child.send({ method: "close" }, () => {});
    } else {
      this.child.kill("SIGKILL");
    }
    await this.exitPromise;
    clearTimeout(forceTimer);
  }
}

export class SupervisedCordisRuntime implements ServerCordisRuntime {
  private readonly dbPath: string;
  private readonly releasesDir: string;
  private readonly startTimeoutMs: number;
  private readonly applyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly drainTimeoutMs: number;

  private readonly artifacts = new Map<string, PluginArtifact>();
  private readonly compositionListeners = new Set<
    (composition: ActiveClientComposition) => void
  >();
  private activeClientComposition: ActiveClientComposition = {
    compositionId: "",
    plugins: [],
  };
  private worker: WorkerProcess | null = null;
  private lastGoodComposition: CompositionSnapshot | null = null;
  private closed = false;

  // Request draining & admission gate
  private inFlightHttp = 0;
  private drainWaiters: Array<() => void> = [];
  private gateDepth = 0;
  private gatePromise: Promise<void> | null = null;
  private releaseGate: (() => void) | null = null;

  // Serialization for apply / recovery
  private exclusiveChain: Promise<void> = Promise.resolve();
  private recoveryPromise: Promise<void> | null = null;

  constructor(options: SupervisedCordisRuntimeOptions) {
    this.dbPath = options.dbPath;
    this.releasesDir = join(options.workDir, "releases");
    this.startTimeoutMs = options.startTimeoutMs ?? 5000;
    this.applyTimeoutMs = options.applyTimeoutMs ?? 5000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? 2000;
    mkdirSync(this.releasesDir, { recursive: true });
  }

  registerArtifact(artifact: PluginArtifact): void {
    this.artifacts.set(
      artifactKey(artifact.pluginId, artifact.versionId),
      artifact,
    );
  }

  getArtifact(pluginId: string, versionId: string): PluginArtifact | undefined {
    return this.artifacts.get(artifactKey(pluginId, versionId));
  }

  getActiveClientComposition(): ActiveClientComposition {
    return this.activeClientComposition;
  }

  subscribeComposition(
    listener: (composition: ActiveClientComposition) => void,
  ): () => void {
    this.compositionListeners.add(listener);
    return () => {
      this.compositionListeners.delete(listener);
    };
  }

  private buildActiveClientComposition(
    composition: CompositionSnapshot,
  ): ActiveClientComposition {
    const plan = validateAndSortComposition(composition.members, this.artifacts);
    return {
      compositionId: composition.compositionId,
      plugins: plan.orderedEnabled.map(({ member, artifact }) => ({
        pluginId: member.pluginId,
        versionId: member.versionId,
        dependencies: [...artifact.dependencies],
        ...(artifact.clientCode !== undefined
          ? {
              clientEntryUrl: `/plugins/${encodeURIComponent(member.pluginId)}/${encodeURIComponent(member.versionId)}/client.mjs`,
            }
          : {}),
        ...(artifact.styleCss !== undefined
          ? { styleCss: artifact.styleCss }
          : {}),
      })),
    };
  }

  private emitCompositionChange(composition: ActiveClientComposition): void {
    this.activeClientComposition = composition;
    for (const listener of [...this.compositionListeners]) {
      try {
        listener(composition);
      } catch {
        // Ignore subscriber errors so one faulty listener never blocks others
      }
    }
  }

  private materializeServerEntry(artifact: PluginArtifact): string | undefined {
    if (artifact.serverCode === undefined) return undefined;
    const safePlugin = artifact.pluginId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const safeVersion = artifact.versionId.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = join(this.releasesDir, `${safePlugin}-${safeVersion}`);
    const filePath = join(dir, "server.mjs");
    if (!existsSync(filePath)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, artifact.serverCode, "utf8");
    }
    return filePath;
  }

  private buildWorkerPayload(composition: CompositionSnapshot) {
    const plan = validateAndSortComposition(composition.members, this.artifacts);
    const mapEntry = (entry: {
      member: { pluginId: string; versionId: string; enabled: boolean };
      artifact: PluginArtifact;
    }) => ({
      pluginId: entry.member.pluginId,
      versionId: entry.member.versionId,
      enabled: entry.member.enabled,
      dependencies: entry.artifact.dependencies,
      contractTypes: entry.artifact.contractTypes,
      entryPath: entry.member.enabled
        ? this.materializeServerEntry(entry.artifact)
        : undefined,
    });

    return {
      compositionId: composition.compositionId,
      allMembers: plan.allMembers.map(mapEntry),
      orderedEnabled: plan.orderedEnabled.map(mapEntry),
    };
  }

  private pauseAdmission(): void {
    this.gateDepth += 1;
    if (!this.gatePromise) {
      this.gatePromise = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
    }
  }

  private resumeAdmission(): void {
    this.gateDepth = Math.max(0, this.gateDepth - 1);
    if (this.gateDepth === 0 && this.releaseGate) {
      const done = this.releaseGate;
      this.gatePromise = null;
      this.releaseGate = null;
      done();
    }
  }

  private waitForDrain(timeoutMs: number): Promise<boolean> {
    if (this.inFlightHttp === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const onDrained = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.drainWaiters = this.drainWaiters.filter((fn) => fn !== onDrained);
        resolve(false);
      }, timeoutMs);
      this.drainWaiters.push(onDrained);
    });
  }

  private notifyDrainWaiters(): void {
    if (this.inFlightHttp === 0 && this.drainWaiters.length > 0) {
      const waiters = this.drainWaiters.splice(0);
      for (const fn of waiters) fn();
    }
  }

  private async spawnWorker(): Promise<WorkerProcess> {
    const worker = await WorkerProcess.spawn(this.dbPath, this.startTimeoutMs);
    worker.onUnexpectedExit = () => {
      if (this.worker === worker) {
        this.worker = null;
      }
      if (!this.closed && this.lastGoodComposition) {
        this.scheduleBackgroundRecovery();
      }
    };
    this.worker = worker;
    return worker;
  }

  private async killWorker(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) {
      await w.kill();
    }
  }

  private async rebuildLastGood(): Promise<void> {
    await this.killWorker();
    if (!this.lastGoodComposition || this.closed) return;
    const worker = await this.spawnWorker();
    const payload = this.buildWorkerPayload(this.lastGoodComposition);
    await worker.call("applyComposition", payload, this.applyTimeoutMs);
  }

  private triggerRecovery(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.pauseAdmission();
    const run = this.runExclusive(async () => {
      if (this.closed) return;
      if (this.worker?.isAlive) return;
      await this.rebuildLastGood();
    }).finally(() => {
      this.recoveryPromise = null;
      this.resumeAdmission();
    });
    this.recoveryPromise = run;
    return run;
  }

  private scheduleBackgroundRecovery(): void {
    this.triggerRecovery().catch((error) => {
      process.stderr.write(
        `[cordis-runtime] background worker recovery failed: ${String(error)}\n`,
      );
    });
  }

  private async awaitReadyWorker(): Promise<WorkerProcess | null> {
    while (true) {
      if (this.closed) {
        throw new Error("CordisAppRuntime is closed");
      }
      if (this.gatePromise) {
        await this.gatePromise;
        continue;
      }
      if (!this.worker?.isAlive) {
        if (!this.lastGoodComposition) return null;
        await this.triggerRecovery();
        continue;
      }
      return this.worker;
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.exclusiveChain.then(fn, fn);
    this.exclusiveChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async commitCompositionOnWorker(
    worker: WorkerProcess,
    target: CompositionSnapshot,
    payload: ReturnType<SupervisedCordisRuntime["buildWorkerPayload"]>,
    mode: RuntimeHealth["mode"],
  ): Promise<RuntimeHealth> {
    try {
      const result = await worker.call<{
        compositionId: string;
        activePlugins: string[];
      }>("applyComposition", payload, this.applyTimeoutMs);
      this.lastGoodComposition = target;
      const clientSnapshot = this.buildActiveClientComposition(target);
      this.emitCompositionChange(clientSnapshot);
      return {
        compositionId: result.compositionId,
        mode,
        workerPid: worker.pid,
        activePlugins: result.activePlugins,
      };
    } catch (error) {
      await this.rebuildLastGood();
      throw error;
    }
  }

  applyComposition(target: CompositionSnapshot): Promise<RuntimeHealth> {
    if (this.closed) {
      return Promise.reject(new Error("CordisAppRuntime is closed"));
    }

    // Validate DAG & artifacts eagerly before disrupting live traffic
    let payload: ReturnType<SupervisedCordisRuntime["buildWorkerPayload"]>;
    try {
      payload = this.buildWorkerPayload(target);
    } catch (error) {
      return Promise.reject(error);
    }

    // Acquire admission gate synchronously so requests arriving immediately
    // after applyComposition() wait behind the hot-swap.
    this.pauseAdmission();
    return this.runExclusive<RuntimeHealth>(async () => {
      if (this.closed) {
        throw new Error("CordisAppRuntime is closed");
      }

      const drained = await this.waitForDrain(this.drainTimeoutMs);
      if (drained && this.worker?.isAlive) {
        return this.commitCompositionOnWorker(
          this.worker,
          target,
          payload,
          "in-process-hot-swap",
        );
      }

      await this.killWorker();
      const worker = await this.spawnWorker();
      return this.commitCompositionOnWorker(
        worker,
        target,
        payload,
        "subprocess-rebuilt",
      );
    }).finally(() => {
      this.resumeAdmission();
    });
  }

  async introspect(): Promise<CompositionTopology> {
    const activeWorker = await this.awaitReadyWorker();
    if (!activeWorker) {
      return {
        compositionId: null,
        workerPid: null,
        plugins: [],
        services: [],
        routes: [],
      };
    }
    return activeWorker.call<CompositionTopology>(
      "introspect",
      undefined,
      this.requestTimeoutMs,
    );
  }

  async handleHttpRequest(req: HttpDispatchInput): Promise<AppResponse> {
    const activeWorker = await this.awaitReadyWorker();
    if (!activeWorker) {
      return {
        status: 503,
        body: { error: "No active plugin composition" },
      };
    }

    this.inFlightHttp += 1;
    try {
      return await activeWorker.call<AppResponse>(
        "http",
        req,
        this.requestTimeoutMs,
      );
    } catch (error) {
      if (!this.closed && !activeWorker.isAlive && this.lastGoodComposition) {
        if (this.worker === activeWorker) {
          this.worker = null;
        }
        // Start recovery synchronously before returning so subsequent requests wait for the rebuilt worker.
        this.scheduleBackgroundRecovery();
      }
      throw error;
    } finally {
      this.inFlightHttp -= 1;
      this.notifyDrainWaiters();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const release = this.releaseGate;
    this.gateDepth = 0;
    this.gatePromise = null;
    this.releaseGate = null;
    release?.();
    const w = this.worker;
    this.worker = null;
    if (w) {
      await w.close();
    }
  }
}
