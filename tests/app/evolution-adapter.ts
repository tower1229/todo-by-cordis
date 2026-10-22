import { referenceFixture, fieldDecisionsFixture, errorDecisionsFixture, admissionFixture } from "./planning-fixture.js";
import { Evolution as HostEvolution } from "../../src/evolution/evolution.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { hash } from "../../src/release/storage.js";
import { candidateArtifact } from "../../src/evolution/candidate-delta.js";
import type { AssistantRun } from "../../src/shared/assistant.js";

/** Migrate old full-artifact model fixtures to the new wire contract, without changing expectations. */
export class DeltaFixture implements Driver {
  private sources: { id: string; text: string }[] = [];
  private basis?: {
    baseVersion: string;
    baseHash: string;
    requirementSeal: string;
    files: { path: string; hash: string }[];
    members: { pluginId: string; hash: string }[];
  };
  constructor(private fixture: Driver) {}
  async generate(request: ModelRequest, signal: AbortSignal) {
    const admission = admissionFixture(request);
    if (admission) return admission;
    if (request.message) {
      const input = JSON.parse(request.message) as {
        delta?: DeltaFixture["basis"];
        sources?: {id:string;text:string}[];
      };
      if (input.delta) this.basis = input.delta;
      if (input.sources) this.sources = input.sources;
    }
    const reply = await this.fixture.generate(request, signal);
    if (request.schema && reply.text && JSON.parse(request.message ?? "{}").kind !== "clarification-review/2") {
      const review = JSON.parse(reply.text) as {
        issues?: Record<string, unknown>[];
        fieldDecisions?: unknown[];
        errorDecisions?: unknown[];
      };
      review.errorDecisions ??= errorDecisionsFixture(JSON.parse(request.message!));
      review.fieldDecisions ??= fieldDecisionsFixture(JSON.parse(request.message!));
      for (const issue of review.issues ?? []) {
        if (issue.technical) continue;
        issue.target ??= {
          subject: String(issue.sourceRevision),
          aspect: "meaning",
        };
        issue.stance ??= "undetermined";
      }
      reply.text = JSON.stringify(review);
    }
    for (const call of reply.calls) {
      if (call.name === "propose_plan")
        call.args = referenceFixture(call.args, this.sources);
      if (
        call.name !== "submit_candidate" ||
        call.args.baseVersion !== undefined ||
        !this.basis
      )
        continue;
      const { source, files, members, ...extra } = call.args;
      const serialized =
        files !== undefined
          ? JSON.stringify({ files, members })
          : typeof source === "string"
            ? source
            : "";
      const artifact = candidateArtifact(serialized);
      const contents = artifact.files ?? { "active-source": artifact.source };
      const submitted = Array.isArray(members)
        ? (members as { pluginId: string; source: string }[])
        : Object.entries(artifact.members).map(([pluginId, source]) => ({
            pluginId,
            source,
          }));
      call.args = {
        ...extra,
        ...(source !== undefined && files !== undefined ? { source } : {}),
        files: Object.entries(contents)
          .filter(
            ([path]) =>
              ![
                "business/view.ts",
                "business/config.json",
                "business/compatibility.json",
              ].includes(path),
          )
          .filter(
            ([path, content]) =>
              this.basis!.files.find((f) => f.path === path)?.hash !==
              hash(content),
          )
          .map(([path, content]) => ({
            path,
            content,
          })),
        members: submitted.map((m) => ({
          ...m,
        })),
      };
    }
    return reply;
  }
}

export class Evolution extends HostEvolution {
  constructor(...args: ConstructorParameters<typeof HostEvolution>) {
    super(args[0], new DeltaFixture(args[1]), args[2], args[3], args[4]);
  }
}

/** Keep raw plan/review fixtures raw, while explicitly accounting for the new intake turn. */
export class AdmissionEvolution extends HostEvolution {
  constructor(...args: ConstructorParameters<typeof HostEvolution>) {
    super(args[0],{generate: (request,signal) => {
      const reply=admissionFixture(request);
      return reply ? Promise.resolve(reply) : args[1].generate(request,signal);
    }},args[2],args[3],args[4]);
  }
}

/** Observe a bounded host run; fixture wall-clock limits must not cancel valid acceptance work. */
export async function settleEvolution(e: Pick<HostEvolution, "observe">, status?: string) {
  const first = (await e.observe()).run;
  if (!first) throw new Error("missing run");
  const isSettled = (run: AssistantRun) => {
    const terminal = !["planning", "executing", "applying"].includes(run.status);
    if (status && terminal && run.status !== status)
      throw new Error(`unexpected host terminal: expected ${status}, observed ${run.status}; ${JSON.stringify(run)}`);
    return run.status === status || terminal;
  };
  if (isSettled(first)) return first;
  if (!first.budget) throw new Error("missing host run budget");
  const deadline = Date.now() + first.budget.millisecondsRemaining + 15_000;
  while (Date.now() < deadline) {
    const run = (await e.observe()).run;
    if (!run || run.id !== first.id) throw new Error("run identity changed while waiting");
    if (isSettled(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout within host run budget: ${JSON.stringify((await e.observe()).run)}`);
}
