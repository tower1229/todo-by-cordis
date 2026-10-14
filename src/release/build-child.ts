import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const dir = process.argv[2];
const bundle = process.argv[3] === "bundle";
try {
  const files = bundle
    ? (JSON.parse(readFileSync(join(dir, "files.json"), "utf8")) as string[])
    : ["candidate.ts", "contract.ts"];
  const source = bundle ? "" : readFileSync(join(dir, "candidate.ts"), "utf8");
  // This is a dependency boundary, not an operating-system security sandbox.
  const stripped = source.replace(
    /import\s+type\s+[\s\S]*?from\s*["']\.\/contract\.js["'];?/g,
    "",
  );
  if (
    /\b(import|require|eval|Function|enum|any)\b/.test(stripped) ||
    /export[^;]*\bfrom\b/.test(stripped)
  )
    throw new Error(
      "Only type imports from ./contract.js are supported; dynamic loading, enum and any are unsupported",
    );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        types: [],
        lib: ["ES2022"],
        skipLibCheck: true,
        noEmitOnError: true,
        noResolve: bundle,
        outDir: "out",
        rootDir: bundle ? "business" : ".",
      },
      files,
    }),
  );
  const require = createRequire(import.meta.url);
  const compiler = join(
    dirname(require.resolve("typescript/package.json")),
    "bin/tsc",
  );
  execFileSync(process.execPath, [compiler, "-p", join(dir, "tsconfig.json")], {
    timeout: 25_000,
    maxBuffer: 100_000,
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.send?.({ ok: true });
} catch (error) {
  const failure = error as Error & { stdout?: Buffer };
  const diagnostic = failure.stdout?.toString() || failure.message;
  const guidance = /\bTS(?:7006|7031)\b/.test(diagnostic)
    ? "\n参数缺少类型：主工作流从 ./contract.js 导入 Plugin，用 const plugin: Plugin = {...} 让方法参数从契约推导；单独声明的定义使用 WorkflowDefinition。不要改成 any、忽略类型检查或修改编译选项。辅助成员仍使用自包含 JavaScript，不导入主工作流契约。"
    : "";
  process.send?.({
    ok: false,
    error: diagnostic.slice(0, 12000 - guidance.length) + guidance,
  });
}
process.disconnect?.();
