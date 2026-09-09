import type { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Runtime } from "../runtime/runtime.js";
import type { BusinessBundle, LaunchTarget, RuntimeLike, Version } from "./types.js";
import { hash } from "./storage.js";
import { checkBusinessImports } from "./business-bundle.js";
import { resolveRuntimePlugins } from "../server/composition.js";

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
  beforeOpenWrites?: () => Promise<void>;
  openWrites(): void;
  compensate(failed: Version, reason: string): Promise<void>;
};
export class Release {
  constructor(
    private db: DatabaseSync,
    readonly directory: string,
    private launch = (version: LaunchTarget): Promise<RuntimeLike> =>
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
      if (input.bundle) {
        for (const [path, content] of Object.entries({
          ...input.bundle.files,
          ...input.bundle.outputs,
        })) {
          const target = join(stage, path);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, content, { mode: 0o444 });
        }
      }
      renameSync(stage, join(this.directory, id));
    }
    this.db
      .prepare("INSERT OR IGNORE INTO plugin_versions VALUES(?,?)")
      .run(id, JSON.stringify(version));
    return this.get(id);
  }
  private verifyArtifacts(version: Version) {
    const root = realpathSync(resolve(this.directory));
    for (const path of [
      "plugin.mjs",
      "source.ts",
      ...Object.keys(version.bundle?.files ?? {}),
      ...Object.keys(version.bundle?.outputs ?? {}),
    ]) {
      const expected = join(root, version.id, path);
      if (realpathSync(expected) !== expected)
        throw new Error("组合路径或符号链接无效");
    }
    if (
      readFileSync(version.entry, "utf8") !== version.code ||
      readFileSync(join(this.directory, version.id, "source.ts"), "utf8") !==
        version.source
    )
      throw new Error("插件产物校验失败");
    if (version.bundle)
      for (const [path, content] of Object.entries({
        ...version.bundle.files,
        ...version.bundle.outputs,
      }))
        if (
          readFileSync(join(this.directory, version.id, path), "utf8") !==
          content
        )
          throw new Error("组合产物校验失败");
  }
  async start(version: Version) {
    this.verifyArtifacts(version);
    const plugins = resolveRuntimePlugins(version, (id) => {
      const member = this.get(id);
      if (member.id !== version.id) this.verifyArtifacts(member);
      return member;
    });
    return this.launch({ ...version, plugins });
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
    files?: Record<string, string>,
  ): Promise<string> {
    if (!source || source.length > 100_000) throw new Error("候选源码长度无效");
    signal.throwIfAborted();
    const dir = join(resolve(this.directory), `candidate-${randomUUID()}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "candidate.ts"), source);
    writeFileSync(join(dir, "contract.ts"), contract);
    if (files) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), content);
      }
      writeFileSync(
        join(dir, "files.json"),
        JSON.stringify(
          Object.keys(files).filter((path) => path.endsWith(".ts")),
        ),
      );
    }
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    try {
      await new Promise<void>((resolve, reject) => {
        const child = fork(
          new URL(`./build-child.${extension}`, import.meta.url),
          [dir, ...(files ? ["bundle"] : [])],
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
      if (files) {
        const outputs: Record<string, string> = {};
        const walk = (folder: string) => {
          for (const entry of readdirSync(join(dir, "out", folder), {
            withFileTypes: true,
          })) {
            const path = join(folder, entry.name);
            if (entry.isDirectory()) walk(path);
            else
              outputs[`business/${path}`] = readFileSync(
                join(dir, "out", path),
                "utf8",
              );
          }
        };
        walk("");
        return JSON.stringify(outputs);
      }
      return readFileSync(join(dir, "out/candidate.js"), "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async buildBundle(
    files: Record<string, string>,
    contract: string,
    signal: AbortSignal,
  ): Promise<BusinessBundle> {
    const complete = { ...files, "business/contract.ts": contract };
    checkBusinessImports(complete);
    const outputs = JSON.parse(
      await this.build("bundle", contract, signal, complete),
    ) as Record<string, string>;
    return {
      files: complete,
      outputs,
      lockHash: hash(readFileSync(resolve("pnpm-lock.yaml"), "utf8")),
      builder: "business-tsc/1",
    };
  }
  async activate(prepared: Prepared, host: Activation, signal?: AbortSignal) {
    let opened = false;
    let committed = false;
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
        committed = true;
        host.install(prepared.runtime);
        try {
          // Post-commit readiness while writes stay frozen; failure compensates.
          await prepared.runtime.invoke("describe");
          signal?.throwIfAborted();
          await host.beforeOpenWrites?.();
          signal?.throwIfAborted();
          host.openWrites();
          opened = true;
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : "提交后就绪检查失败";
          // Cancel after commit must not undo publish; continue readiness/openWrites.
          if (signal?.aborted && committed) {
            try {
              await prepared.runtime.invoke("describe");
              await host.beforeOpenWrites?.();
              host.openWrites();
              opened = true;
              return;
            } catch (readyError) {
              const readyReason =
                readyError instanceof Error
                  ? readyError.message
                  : "提交后就绪检查失败";
              await host.compensate(prepared.version, readyReason);
              throw readyError instanceof Error
                ? readyError
                : new Error(readyReason);
            }
          }
          await host.compensate(prepared.version, reason);
          throw error instanceof Error ? error : new Error(reason);
        }
      });
    } finally {
      if (!opened) await prepared.runtime.close();
    }
  }
}
