import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { source } from "./evolution-fixture.js";
import { toolReply } from "./planning-fixture.js";

/** Model fixture that plans with PlanningDriver, then submits a verified candidate. */
export class ExecutionDriver implements Driver {
  requests: ModelRequest[] = [];
  constructor(
    private planning: Driver,
    private pluginId = "default",
    private name = "轻快完成",
    private minimum = 1,
  ) {}
  async generate(request: ModelRequest, signal = new AbortController().signal) {
    this.requests.push(request);
    if (
      request.tools?.some((t) => t.name === "submit_candidate") ||
      request.tools?.some((t) => t.name === "build_candidate")
    ) {
      const reply = (name: string, args: Record<string, unknown>) => ({
        ...toolReply(name, args),
        history: request.history,
      });
      const content = JSON.stringify(request.history);
      if (!content.includes("read_contract")) return reply("read_contract", {});
      if (!content.includes("read_current_source"))
        return reply("read_current_source", {});
      return reply("submit_candidate", {
        source: source(this.pluginId, this.name, this.minimum),
      });
    }
    return this.planning.generate(request, signal);
  }
}
