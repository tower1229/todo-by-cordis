import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { buildHostSdkContracts } from "../../src/contracts/host-sdk-reference.js";

const execFileAsync = promisify(execFile);

describe("Host SDK single-source reference", () => {
  it("derives accurate server/client SDK & Cordis Context contracts without drift or dangling types", () => {
    const contracts = buildHostSdkContracts();

    assert.match(contracts, /\breadonly db:\s*ScopedDb;/);
    assert.match(contracts, /\breadonly http:\s*HttpRouter;/);
    assert.match(contracts, /\breadonly schedule:\s*SchedulerService;/);
    assert.match(
      contracts,
      /\breadonly router:\s*import\("@host\/client-sdk"\)\.ClientRouter;/,
    );
    assert.match(
      contracts,
      /\breadonly slots:\s*import\("@host\/client-sdk"\)\.SlotRegistry;/,
    );
    assert.match(contracts, /export interface PluginManifest\b/);
    assert.match(contracts, /export interface PluginArtifact\b/);
    assert.match(contracts, /export interface ActiveClientComposition\b/);
    assert.match(contracts, /export function pluginTablePrefix\(/);
    assert.match(contracts, /export function dispatchServerBail</);
    assert.match(contracts, /export function dispatchClientBail</);
    assert.match(contracts, /export function Slot</);
    assert.match(contracts, /export type PluginTestContext =/);

    // Guard against historical drift bugs and internal bridge leaks
    assert.doesNotMatch(contracts, /\breadonly scheduler:/);
    assert.doesNotMatch(contracts, /from "\.\/types\.js"/);
    assert.doesNotMatch(contracts, /ClientRuntimeProvider|useClientRuntimeBridge/);

    // Ensure `declare module "cordis"` block does not pull unrelated topology types or dangling symbols
    const cordisBlockIdx = contracts.indexOf('declare module "cordis"');
    assert.ok(cordisBlockIdx >= 0);
    const cordisBlock = contracts.slice(cordisBlockIdx);
    assert.doesNotMatch(cordisBlock, /\bFiberStateName\b/);
    assert.doesNotMatch(cordisBlock, /\bPluginTopologyEntry\b/);
    assert.doesNotMatch(cordisBlock, /\bRouteDescriptor\b/);
  });

  it("typechecks cleanly without skipLibCheck masking errors inside the generated declarations", async () => {
    const workspaceRoot = resolve(process.cwd());
    const tscBin = join(workspaceRoot, "node_modules", ".bin", "tsc");
    const tempDir = mkdtempSync(join(tmpdir(), "host-sdk-contract-check-"));
    try {
      symlinkSync(
        join(workspaceRoot, "node_modules"),
        join(tempDir, "node_modules"),
        "dir",
      );
      writeFileSync(
        join(tempDir, "host-sdk.d.ts"),
        buildHostSdkContracts(),
        "utf8",
      );
      writeFileSync(
        join(tempDir, "sample.tsx"),
        `
import type { Context } from "cordis";
import {
  dispatchServerBail,
  pluginTablePrefix,
  type PluginArtifact,
  type PluginManifest,
  type PluginTestContext,
  type ScopedDb,
} from "@host/server-sdk";
import {
  Slot,
  dispatchClientBail,
  useClientContext,
  useCurrentPath,
  useNavigate,
  type ActiveClientComposition,
  type ClientDiagnostic,
} from "@host/client-sdk";

export function serverApply(ctx: Context) {
  const db: ScopedDb = ctx.db;
  const prefix: string = pluginTablePrefix("demo");
  ctx.http.route("GET", "/ping", () => ({ prefix, tablePrefix: db.tablePrefix }));
  ctx.schedule.every(1000, () => {});
  void dispatchServerBail(ctx, "demo:check", { ok: true });
}

export function acceptMeta(
  _manifest: PluginManifest,
  _artifact: PluginArtifact,
  _clientComp: ActiveClientComposition,
  _diag: ClientDiagnostic,
) {}

export function ClientWidget() {
  const ctx = useClientContext();
  const path = useCurrentPath();
  const navigate = useNavigate();
  void dispatchClientBail(ctx, "demo:ui", { path });
  return <div onClick={() => navigate("/")}><Slot name="demo.slot" /></div>;
}

export async function sampleTest(testCtx: PluginTestContext) {
  await testCtx.request({ method: "GET", path: "/api/app/demo/ping" });
}
`,
        "utf8",
      );
      writeFileSync(
        join(tempDir, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              target: "ES2023",
              module: "ESNext",
              moduleResolution: "bundler",
              jsx: "react-jsx",
              strict: true,
              noEmit: true,
              skipLibCheck: false,
              types: ["node"],
            },
            include: ["host-sdk.d.ts", "sample.tsx"],
          },
          null,
          2,
        ),
        "utf8",
      );
      await execFileAsync(
        tscBin,
        ["--noEmit", "-p", join(tempDir, "tsconfig.json")],
        { cwd: workspaceRoot },
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
