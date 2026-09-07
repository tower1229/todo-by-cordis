import type { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Runtime } from "../runtime/runtime.js";
import type { RuntimeLike, Version } from "./types.js";
import { hash } from "./storage.js";

export type Prepared = {
  version: Version;
  runtime: RuntimeLike;
  preparationMs: number;
};
export type Activation = {
  serial<T>(work: () => Promise<T>): Promise<T>;
  check(version: Version): void;
  commit(
    version: Version,
    metrics: { pausedMs: number; preparationMs: number },
  ): void;
  install(runtime: RuntimeLike): void;
};
export class Release {
  constructor(
    private db: DatabaseSync,
    readonly directory: string,
    private launch = (version: Version): Promise<RuntimeLike> =>
      Runtime.start(version),
  ) {
    mkdirSync(directory, { recursive: true });
    db.exec(
      "CREATE TABLE IF NOT EXISTS plugin_versions(id TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
  }
  get(id: string): Version {
    const row = this.db
      .prepare("SELECT body FROM plugin_versions WHERE id=?")
      .get(id);
    if (!row) throw new Error("找不到插件版本");
    const version = JSON.parse(String(row.body)) as Version;
    return {
      ...version,
      entry: join(resolve(this.directory), version.id, "plugin.mjs"),
    };
  }
  all(): Version[] {
    return this.db
      .prepare("SELECT body FROM plugin_versions ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(String(row.body)) as Version);
  }
  record(input: Omit<Version, "id" | "entry" | "createdAt">): Version {
    const id = hash(input);
    const entry = join(resolve(this.directory), id, "plugin.mjs");
    const version: Version = {
      ...input,
      id,
      entry,
      createdAt: new Date().toISOString(),
    };
    if (!existsSync(entry)) {
      const stage = join(this.directory, `staging-${randomUUID()}`);
      mkdirSync(stage);
      writeFileSync(join(stage, "plugin.mjs"), input.code, { mode: 0o444 });
      writeFileSync(join(stage, "source.ts"), input.source, { mode: 0o444 });
      renameSync(stage, join(this.directory, id));
    }
    this.db
      .prepare("INSERT OR IGNORE INTO plugin_versions VALUES(?,?)")
      .run(id, JSON.stringify(version));
    return this.get(id);
  }
  async start(version: Version) {
    if (
      readFileSync(version.entry, "utf8") !== version.code ||
      readFileSync(join(this.directory, version.id, "source.ts"), "utf8") !==
        version.source
    )
      throw new Error("插件产物校验失败");
    return this.launch(version);
  }
  async prepare(
    version: Version,
    verify: (runtime: RuntimeLike) => Promise<unknown>,
  ): Promise<Prepared> {
    const started = performance.now();
    const runtime = await this.start(version);
    try {
      await verify(runtime);
      return { version, runtime, preparationMs: performance.now() - started };
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }
  async build(
    source: string,
    contract: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!source || source.length > 100_000) throw new Error("候选源码长度无效");
    signal.throwIfAborted();
    const dir = join(resolve(this.directory), `candidate-${randomUUID()}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "candidate.ts"), source);
    writeFileSync(join(dir, "contract.ts"), contract);
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    try {
      await new Promise<void>((resolve, reject) => {
        const child = fork(
          new URL(`./build-child.${extension}`, import.meta.url),
          [dir],
          {
            execArgv: extension === "ts" ? ["--import", "tsx"] : [],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            env: {},
            detached: process.platform !== "win32",
          },
        );
        let settled = false;
        const stop = () => {
          if (process.platform !== "win32" && child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          } else child.kill("SIGKILL");
        };
        const timer = setTimeout(stop, 30_000);
        signal.addEventListener("abort", stop, { once: true });
        let result: { ok: boolean; error?: string } | undefined;
        child.on("message", (value: unknown) => {
          result = value as typeof result;
        });
        child.on("error", reject);
        child.on("close", () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", stop);
          if (settled) return;
          settled = true;
          if (signal.aborted) reject(signal.reason);
          else if (result?.ok) resolve();
          else reject(new Error(result?.error ?? "构建超时或进程退出"));
        });
      });
      return readFileSync(join(dir, "out/candidate.js"), "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async activate(prepared: Prepared, host: Activation, signal?: AbortSignal) {
    let installed = false;
    try {
      return await host.serial(async () => {
        signal?.throwIfAborted();
        host.check(prepared.version);
        // Recheck liveness immediately before the synchronous commit section.
        await prepared.runtime.invoke("describe");
        signal?.throwIfAborted();
        host.check(prepared.version);
        const paused = performance.now();
        host.commit(prepared.version, {
          preparationMs: prepared.preparationMs,
          pausedMs: performance.now() - paused,
        });
        host.install(prepared.runtime);
        installed = true;
      });
    } finally {
      if (!installed) await prepared.runtime.close();
    }
  }
}
