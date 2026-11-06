#!/usr/bin/env node
/**
 * r11 paid-phase gate.
 * Missing evidence refuses before any provider key is read and before
 * real/targeted or real/chains is created. Even when every listed file
 * exists, directories stay uncreated unless the process is invoked with
 * --authorize-real-directories. This file never reads DEEPSEEK_API_KEY
 * and never writes into an older batch directory.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const batch =
  process.argv[2] ?? "docs/reports/r11-20261104";
const sealedRoot = ".runtime/continuous-revision-study-20261104-r10";
const required = [
  join(sealedRoot, "prepaid-validation-sha256.json"),
  join(sealedRoot, "audit-targeted-v2.py"),
  join(sealedRoot, "audit-real-study-v2.py"),
  join(sealedRoot, "audit-outbound-payload.mjs"),
  join(sealedRoot, "real-chains-failure-sha256.json"),
  ".runtime/continuous-revision-study-20261103/upgrade-baseline/workspace.db",
  ".runtime/continuous-revision-study-20261103/counter-baseline/workspace.db",
  join(batch, "ci-gate.json"),
  join(batch, "source-freeze.json"),
  join(batch, "prepaid-rehearsal-audit.json"),
  join(batch, "incident-observation.json"),
];
const missing = required.filter((path) => !existsSync(path));
const targeted = join(batch, "real", "targeted");
const chains = join(batch, "real", "chains");
if (existsSync(targeted) || existsSync(chains)) {
  console.error(
    JSON.stringify({
      decision: "refused",
      reason: "paid experiment directories already exist",
      keyRead: false,
    }),
  );
  process.exit(3);
}
const authorizeDirectories = process.argv.includes(
  "--authorize-real-directories",
);
if (missing.length > 0 || !authorizeDirectories) {
  console.log(
    JSON.stringify(
      {
        decision: "refused",
        beforeKeyLoad: true,
        keyRead: false,
        experimentDirectoriesCreated: false,
        missing,
        realDirectoryAuthorization: authorizeDirectories,
        reason: missing.length > 0
          ? "required-evidence-missing"
          : "real-directory-authorization-not-present",
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
mkdirSync(targeted, { recursive: true });
mkdirSync(chains, { recursive: true });
console.log(
  JSON.stringify({
    decision: "gates-present",
    experimentDirectoriesCreated: true,
    note: "directory creation is not a model call",
  }),
);
