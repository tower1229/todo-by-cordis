import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildPluginPackage,
  typecheckPluginPackage,
} from "../../src/v3/plugin-builder.js";

const TODO_CORE_CONTRACT = readFileSync(
  join(process.cwd(), "plugins/todo-core/contract.d.ts"),
  "utf8",
);

describe("V3 Full-Stack Plugin Builder (with strict TypeScript typecheck)", () => {
  it("typechecks downstream plugin against upstream contract.d.ts and builds immutable artifact", async () => {
    const serverSource = `
import type { Context } from "cordis";
import "@host/server-sdk";

export const name = "review";
export const inject = ["todo"] as const;

export function apply(ctx: Context) {
  ctx.on("todo:before-transition", async ({ task, nextState }) => {
    if (nextState === "done" && task.title.length === 0) {
      return "empty title";
    }
  });
}
`;

    const clientSource = `
import type { Context } from "cordis";
import { useState } from "react";
import "@host/client-sdk";

export const name = "review";

export function apply(ctx: Context) {
  ctx.slots.register("todo.item.badges", ({ task }) => {
    const [open] = useState(false);
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        {open ? task.title : "review"}
      </span>
    );
  });
}
`;

    const artifact = await buildPluginPackage({
      pluginId: "review",
      name: "Review",
      dependencies: ["todo-core"],
      upstreamContracts: {
        "todo-core": TODO_CORE_CONTRACT,
      },
      serverSource,
      clientSource,
    });

    assert.equal(artifact.pluginId, "review");
    assert.match(artifact.versionId, /^[0-9a-f]{16}$/);
    assert.ok(artifact.serverCode && artifact.serverCode.includes("todo:before-transition"));
    assert.ok(artifact.clientCode && artifact.clientCode.includes('from "react"'));
    assert.ok(artifact.styleCss && artifact.styleCss.includes(".bg-amber-100"));
    assert.ok(!artifact.styleCss.includes("box-sizing: border-box"));
  });

  it("rejects plugins with TypeScript type errors against upstream contracts", async () => {
    const badServerSource = `
import type { Context } from "cordis";
import "@host/server-sdk";

export const name = "review";
export const inject = ["todo"] as const;

export function apply(ctx: Context) {
  // Invalid: nonExistentMethod does not exist on TodoService
  ctx.todo.nonExistentMethod(123);
}
`;

    const result = await typecheckPluginPackage({
      pluginId: "review",
      upstreamContracts: {
        "todo-core": TODO_CORE_CONTRACT,
      },
      sourceFiles: {
        "server.ts": badServerSource,
      },
    });

    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(
      result.diagnostics.some((d) => d.includes("nonExistentMethod")),
      `Expected diagnostic mentioning nonExistentMethod, got: ${result.diagnostics.join("\n")}`,
    );
  });

  it("rejects upstreamContracts that are not declared in plugin dependencies", async () => {
    await assert.rejects(
      () =>
        buildPluginPackage({
          pluginId: "review",
          name: "Review",
          dependencies: [],
          upstreamContracts: {
            "todo-core": TODO_CORE_CONTRACT,
          },
          serverSource: `export const name = "review"; export function apply() {}`,
        }),
      /not declared in plugin "review" dependencies/,
    );
  });
});
