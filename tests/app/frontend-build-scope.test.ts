import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

test("前端构建只依赖应用源码，评测资料和历史产物不改变资源身份", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-build-scope-"));
  const run = promisify(execFile);
  try {
    for (const path of ["src", "index.html", "vite.config.ts", "package.json", ".gitignore"])
      await cp(join(process.cwd(), path), join(root, path), { recursive: true });
    await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
    const build = async () => {
      await run(process.execPath, [join(process.cwd(), "node_modules/vite/bin/vite.js"), "build"], {
        cwd: root, timeout: 60_000, maxBuffer: 2_000_000,
      });
      const files = ["index.html", ...(await readdir(join(root, "dist/web/assets"))).map((name) => `assets/${name}`)];
      return Object.fromEntries(await Promise.all(files.sort().map(async (name) => [
        name, createHash("sha256").update(await readFile(join(root, "dist/web", name))).digest("hex"),
      ])));
    };
    const clean = await build();
    await mkdir(join(root, "evaluation-data"));
    await writeFile(join(root, "evaluation-data/archived-response.html"),
      '<div class="w-[12345px] rotate-[37deg] text-red-950">synthetic archived output</div>');
    assert.deepEqual(await build(), clean);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
