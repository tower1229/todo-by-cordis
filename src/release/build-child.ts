import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const dir = process.argv[2];
try {
  const source = readFileSync(join(dir, "candidate.ts"), "utf8");
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
        outDir: "out",
      },
      files: ["candidate.ts", "contract.ts"],
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
  process.send?.({
    ok: false,
    error: (failure.stdout?.toString() || failure.message).slice(0, 12000),
  });
}
process.disconnect?.();
