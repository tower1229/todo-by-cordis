import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { Workspace } from "../../src/server/workspace.js";
import type { Driver } from "../../src/evolution/driver.js";
import { createApp } from "../../src/server/app.js";

export function evolutionWithExperience(w: Workspace, driver: Driver) {
  const sessions = new ExperienceSessionHost(w);
  const domain = new EvolutionDomain(w);
  const evolution = new Evolution(w.db, driver, domain, sessions);
  return {
    evolution,
    sessions,
    domain,
    app: createApp(w, evolution, sessions),
  };
}
