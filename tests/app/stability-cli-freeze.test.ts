import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, cp, symlink, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("CLI 零 API 预检自动冻结评测源码与夹具目录，不遗漏新增基线依赖", async () => {
  const root = await mkdtemp(join(tmpdir(), "stability-cli-freeze-"));
  const source = join(root, "source");
  const archive = join(root, "preflight");
  const run = promisify(execFile);
  try {
    for (const path of ["src", "scripts", "tests"])
      await cp(join(process.cwd(), path), join(source, path), { recursive: true });
    const files = (await readdir(process.cwd(), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /\.(json|ts|html|yaml)$/.test(entry.name))
      .map((entry) => entry.name);
    for (const name of [...files, ".gitignore"])
      await cp(join(process.cwd(), name), join(source, name));
    const probe = "tests/fixtures/baseline-inventory-probe.json";
    await writeFile(join(source, probe), JSON.stringify({ purpose: "synthetic dependency inventory regression" }));
    await symlink(join(process.cwd(), "node_modules"), join(source, "node_modules"), "dir");
    const options = { cwd: source, timeout: 60_000, maxBuffer: 2_000_000 };
    await run("git", ["init", "--quiet"], options);
    await run("git", ["add", "--", "src", "scripts", "tests", ...files, ".gitignore"], options);
    await run("git", ["-c", "user.name=Stability fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--quiet", "-m", "Freeze synthetic preflight fixture"], options);
    await run(process.execPath, ["--import", "tsx", "scripts/accept-stability-baseline.ts",
      "--current", "--extended-time", "--responsibility", "--prepare-only", "--stub"], {
      ...options, env: { ...process.env, STABILITY_EVAL_PATH: archive,
        COREPACK_ENABLE_NETWORK: "0", PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false" },
    });
    const identity = JSON.parse(await readFile(join(archive, "identity.json"), "utf8")) as { harnessFiles: Record<string, string> };
    assert.ok(Object.hasOwn(identity.harnessFiles, "tests/fixtures/stability-tags-baseline.mjs"));
    assert.ok(Object.hasOwn(identity.harnessFiles, probe));
    assert.ok(Object.hasOwn(identity.harnessFiles, "scripts/lib/stability-eval/baseline.ts"));
    const preflight = JSON.parse(await readFile(join(archive, "prepared.json"), "utf8")) as { apiCalls: number; executionComplete: boolean };
    assert.equal(preflight.apiCalls, 0);
    assert.equal(preflight.executionComplete, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
