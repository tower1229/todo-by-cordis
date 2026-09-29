import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Independent top-level links allow faults without modifying the installed package store. */
export function linkDependencies(source: string, target: string) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      mkdirSync(join(target, entry), { recursive: true });
      for (const child of readdirSync(join(source, entry)))
        symlinkSync(
          realpathSync(join(source, entry, child)),
          join(target, entry, child),
        );
    } else symlinkSync(realpathSync(join(source, entry)), join(target, entry));
  }
  // Build tools are executable links; these are never fault-injected.
  symlinkSync(join(source, ".bin"), join(target, ".bin"));
}

export function dependencyFault(directory: string): {
  restore(): void;
  evidence: object;
} {
  const original = process.cwd();
  const isolated = mkdtempSync(join(tmpdir(), "cordis-dependency-fault-"));
  for (const path of ["src", "tests", "package.json", "pnpm-lock.yaml"])
    cpSync(join(original, path), join(isolated, path), { recursive: true });
  symlinkSync(join(original, "dist"), join(isolated, "dist"));
  linkDependencies(
    join(original, "node_modules"),
    join(isolated, "node_modules"),
  );
  const healthy = execFileSync(
    process.execPath,
    ["-e", "console.log(require.resolve('@types/node/package.json'))"],
    { cwd: isolated, encoding: "utf8" },
  ).trim();
  unlinkSync(join(isolated, "node_modules/@types/node"));
  // Use a fresh resolution process: require.resolve caches successful resolutions.
  process.chdir(isolated);
  return {
    restore: () => {
      process.chdir(original);
      rmSync(isolated, { recursive: true, force: true });
    },
    evidence: {
      dependency: "@types/node",
      healthy,
      fault: "isolated-resolution-entry-removed",
    },
  };
}
