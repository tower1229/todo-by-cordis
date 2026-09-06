import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    stdio: "inherit",
    windowsHide: true,
  }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
    stdio: "inherit",
    windowsHide: true,
  }),
];
let closing = false;
function close() {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill();
}
for (const child of children) child.on("exit", close);
process.on("SIGINT", close);
process.on("SIGTERM", close);
