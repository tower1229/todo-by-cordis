import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["--import", "tsx", "src/v3/main.ts"], {
  stdio: "inherit",
  windowsHide: true,
});

function close(signal) {
  if (!child.killed) {
    child.kill(signal);
  }
}

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
process.on("SIGINT", () => close("SIGINT"));
process.on("SIGTERM", () => close("SIGTERM"));
