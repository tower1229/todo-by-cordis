import { createRoot } from "react-dom/client";
import { ClientRuntimeProvider } from "../client-sdk.js";
import { AppHost } from "./app-host.js";
import { ClientCordisRuntime } from "./client-runtime.js";
import { SupervisorShell } from "./supervisor-shell.js";
import "./host-base.css";

declare global {
  interface Window {
    __v3ClientRuntime?: ClientCordisRuntime;
  }
}

export function bootV3BrowserApp(): ClientCordisRuntime {
  const runtime = new ClientCordisRuntime();
  window.__v3ClientRuntime = runtime;

  const supervisorRootEl = document.getElementById("supervisor-root");
  if (supervisorRootEl) {
    createRoot(supervisorRootEl).render(
      <ClientRuntimeProvider runtime={runtime}>
        <SupervisorShell />
      </ClientRuntimeProvider>,
    );
  }

  const appRootEl = document.getElementById("app-root");
  if (appRootEl) {
    createRoot(appRootEl).render(
      <ClientRuntimeProvider runtime={runtime}>
        <AppHost />
      </ClientRuntimeProvider>,
    );
  }

  runtime.connectSse();
  return runtime;
}

if (typeof document !== "undefined") {
  bootV3BrowserApp();
}
