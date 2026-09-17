import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { source } from "./evolution-fixture.js";

/** Pinned workflow source + submitted members for Evolution member tests. */
export function pinnedMemberDriver(
  planning: PlanningDriver,
  workflowSource: () => string,
  members: () => { pluginId: string; source: string }[],
): Driver {
  return {
    async generate(request: ModelRequest, signal) {
      if (
        request.tools?.some((tool) => tool.name === "submit_candidate") ||
        request.tools?.some((tool) => tool.name === "build_candidate")
      ) {
        const content = JSON.stringify(request.history);
        if (!content.includes("read_contract"))
          return { ...toolReply("read_contract", {}), history: request.history };
        if (!content.includes("read_current_source"))
          return {
            ...toolReply("read_current_source", {}),
            history: request.history,
          };
        return {
          ...toolReply("submit_candidate", {
            source: workflowSource(),
            members: members(),
          }),
          history: request.history,
        };
      }
      return planning.generate(request, signal);
    },
  };
}

export function typedWorkflowMemberDriver(
  planning: PlanningDriver,
  members: () => { pluginId: string; source: string }[],
): Driver {
  return pinnedMemberDriver(
    planning,
    () => source("aux-workflow", "双贡献组合", 1),
    members,
  );
}
