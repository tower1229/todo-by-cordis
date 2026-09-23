import { existsSync } from "node:fs";
import { Evolution } from "../evolution/evolution.js";
import { Gemini } from "../evolution/gemini.js";
import { EvolutionDomain } from "./evolution-domain.js";
import { startHost } from "./host/bootstrap.js";

if (existsSync(".env")) process.loadEnvFile(".env");

await startHost({
  databasePath: process.env.DATABASE_PATH ?? ".runtime/workspace.db",
  port: Number(process.env.PORT ?? 4517),
  logLabel: "Cordis",
  createAssistant: (workspace, sessions) => {
    if (!process.env.GEMINI_API_KEY || process.env.AI_DISABLED === "1")
      return undefined;
    return new Evolution(
      workspace.db,
      new Gemini(process.env.GEMINI_API_KEY),
      new EvolutionDomain(workspace),
      sessions,
    );
  },
});
