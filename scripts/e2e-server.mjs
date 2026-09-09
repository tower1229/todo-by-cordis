import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = await mkdtemp(join(tmpdir(), "cordis-browser-"));
process.env.AI_DISABLED = "1";
process.env.E2E_FIXTURES = "1";
process.env.PORT = "4518";
process.env.DATABASE_PATH = join(dir, "test.db");
process.once("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});
await import("../dist/server/main.js");
