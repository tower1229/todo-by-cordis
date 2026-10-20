import { existsSync } from "node:fs";
import { Evolution } from "../evolution/evolution.js";
import { DeepSeek } from "../evolution/deepseek.js";
import { EvolutionDomain } from "./evolution-domain.js";
import { startHost } from "./host/bootstrap.js";
import { evolutionBudget } from "./evolution-budget.js";

if (existsSync(".env")) process.loadEnvFile(".env");

await startHost({
  databasePath: process.env.DATABASE_PATH ?? ".runtime/workspace.db",
  port: Number(process.env.PORT ?? 4517),
  logLabel: "Cordis",
  createAssistant: (workspace, sessions) => {
    if (!process.env.DEEPSEEK_API_KEY || process.env.AI_DISABLED === "1")
      return undefined;
    return new Evolution(
      workspace.db,
      new DeepSeek(process.env.DEEPSEEK_API_KEY),
      new EvolutionDomain(workspace),
      sessions,
      evolutionBudget(process.env),
    );
  },
});
