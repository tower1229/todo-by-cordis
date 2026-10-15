import { execFileSync } from "node:child_process";
import { setGlobalProxyFromEnv, type ProxyEnv } from "node:http";

export type ModelNetwork = {
  source: "environment" | "macos-system" | "direct";
  proxyOrigin?: string;
};
type Policy = { network: ModelNetwork; proxyEnv?: ProxyEnv };
const loopback = "localhost,127.0.0.1,::1";

function proxyOrigin(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("模型代理仅支持 HTTP/HTTPS 代理");
  return url.origin;
}

/** Resolve once before the first SDK request. Never change routes after a failed request. */
export function modelNetworkPolicy(
  env: Record<string, string | undefined>,
  platform: string,
  readSystemProxy: () => string,
): Policy {
  if (env.NODE_USE_ENV_PROXY === "0") return { network: { source: "direct" } };
  let http = env.http_proxy || env.HTTP_PROXY;
  let https = env.https_proxy || env.HTTPS_PROXY;
  let source: ModelNetwork["source"] = "environment";
  let exceptions = env.no_proxy || env.NO_PROXY || "";
  if (!http && !https && platform === "darwin") {
    const settings = readSystemProxy();
    const value = (key: string) =>
      settings.match(new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)\\s*$`, "m"))?.[1];
    const address = (prefix: string) => {
      if (value(prefix + "Enable") !== "1") return undefined;
      const host = value(prefix + "Proxy");
      const port = value(prefix + "Port");
      if (!host || !port || !/^\d+$/.test(port) || +port < 1 || +port > 65535)
        throw new Error("系统模型代理的地址或端口无效");
      return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    };
    http = address("HTTP");
    https = address("HTTPS");
    source = "macos-system";
    const systemExceptions = settings.match(
      /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/,
    )?.[1];
    exceptions = [
      exceptions,
      ...(systemExceptions
        ?.split("\n")
        .map((line) => line.match(/\d+\s*:\s*(\S+)/)?.[1])
        .filter((v): v is string => !!v && v !== "<local>") ?? []),
    ]
      .filter(Boolean)
      .join(",");
  }
  if (!http && !https) return { network: { source: "direct" } };
  // Validate both before changing Node's process-wide dispatcher. Never log credentials.
  if (http) proxyOrigin(http);
  const origin = proxyOrigin(https || http!);
  return {
    network: { source, proxyOrigin: origin },
    proxyEnv: {
      http_proxy: http,
      https_proxy: https || http,
      no_proxy: [exceptions, loopback].filter(Boolean).join(","),
    },
  };
}

let configured: ModelNetwork | undefined;
export function configureModelNetwork(): ModelNetwork {
  if (configured) return configured;
  const policy = modelNetworkPolicy(process.env, process.platform, () =>
    execFileSync("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 1000,
    }),
  );
  // The SDK uses native fetch. Node does not read macOS proxy settings itself.
  // Configure once, including loopback bypass for isolated services; no per-call swap.
  if (policy.proxyEnv) setGlobalProxyFromEnv(policy.proxyEnv);
  configured = policy.network;
  return configured;
}
