export type TransportFailure = {
  kind:
    | "dns"
    | "connection"
    | "tls"
    | "timeout"
    | "cancelled"
    | "http"
    | "unknown";
  elapsedMs: number;
  causes: { name?: string; message: string; code?: string; syscall?: string }[];
};

export function transportFailure(
  error: unknown,
  key: string,
  elapsedMs: number,
  signal: AbortSignal,
  httpStatus?: number,
): TransportFailure {
  const causes: TransportFailure["causes"] = [];
  const seen = new Set<unknown>();
  const redact = (value: string) =>
    (key ? value.replaceAll(key, "[redacted]") : value)
      .replace(/https?:\/\/[^\s/]+@/gi, "https://[redacted]@")
      .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 2048);
  const visit = (value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      seen.has(value) ||
      causes.length >= 8
    )
      return;
    seen.add(value);
    const v = value as Record<string, unknown>;
    const text = (k: string) =>
      typeof v[k] === "string" ? redact(v[k]) : undefined;
    causes.push({
      name: text("name"),
      message: text("message") ?? "模型传输异常",
      code: text("code"),
      syscall: text("syscall"),
    });
    visit(v.cause);
    if (Array.isArray(v.errors)) v.errors.forEach(visit);
  };
  visit(error);
  if (signal.aborted) visit(signal.reason);
  const codes = causes.map((c) => c.code || c.name || "");
  const has = (pattern: RegExp) => codes.some((c) => pattern.test(c));
  const kind =
    httpStatus !== undefined
      ? "http"
      : has(/TIMEOUT|ETIMEDOUT|TimeoutError/)
        ? "timeout"
        : signal.aborted || has(/^AbortError$/)
          ? "cancelled"
          : has(/ENOTFOUND|EAI_AGAIN/)
            ? "dns"
            : has(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/)
              ? "tls"
              : has(/UND_ERR_SOCKET|ECONN|EPIPE|ENET|EHOST/)
                ? "connection"
                : "unknown";
  return { kind, elapsedMs: Math.round(elapsedMs), causes };
}
