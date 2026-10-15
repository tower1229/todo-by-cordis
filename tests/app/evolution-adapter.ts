import { referenceFixture, fieldDecisionsFixture, admissionFixture } from "./planning-fixture.js";
import { Evolution as HostEvolution } from "../../src/evolution/evolution.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { hash } from "../../src/release/storage.js";
import { candidateArtifact } from "../../src/evolution/candidate-delta.js";

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
        delta?: typeof this.basis;
        sources?: typeof this.sources;
      };
      if (input.delta) this.basis = input.delta;
      if (input.sources) this.sources = input.sources;
    }
    const reply = await this.fixture.generate(request, signal);
    if (request.schema && reply.text && JSON.parse(request.message ?? "{}").kind !== "clarification-review/1") {
      const review = JSON.parse(reply.text) as {
        issues?: Record<string, unknown>[];
        fieldDecisions?: unknown[];
      };
      review.fieldDecisions ??= fieldDecisionsFixture(JSON.parse(request.message!));
      for (const issue of review.issues ?? []) {
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
