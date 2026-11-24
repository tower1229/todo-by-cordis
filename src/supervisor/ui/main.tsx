import { createRoot } from "react-dom/client";
import { ClientRuntimeProvider } from "../../runtime/client/runtime-bridge.js";
import { AppHost } from "../../runtime/client/app-host.js";
import { ClientCordisRuntime } from "../../runtime/client/client-runtime.js";
import { SupervisorShell } from "./supervisor-shell.js";
import "../../runtime/client/host-base.css";

declare global {
  interface Window {
    __cordisClientRuntime?: ClientCordisRuntime;
  }
}

export function bootBrowserHost(): ClientCordisRuntime {
  const runtime = new ClientCordisRuntime();
  window.__cordisClientRuntime = runtime;

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
  bootBrowserHost();
}
