import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { modelNetworkPolicy } from "../../src/evolution/model-network.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { ModelTransportError } from "../../src/evolution/driver.js";

const system = `<dictionary> {
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 7897
  HTTPSEnable : 1
  ExceptionsList : <array> {
    0 : *.local
  }
}`;

test("采用已开启的macOS代理；环境配置优先、元数据脱敏且隔离服务直连", () => {
  const fallback = modelNetworkPolicy({}, "darwin", () => system);
  assert.deepEqual(fallback.network, {
    source: "macos-system",
    proxyOrigin: "http://127.0.0.1:7897",
  });
  assert.equal(fallback.proxyEnv?.https_proxy, "http://127.0.0.1:7897");
  assert.match(
    fallback.proxyEnv!.no_proxy!,
    /\*\.local,localhost,127\.0\.0\.1,::1/,
  );
  const explicit = modelNetworkPolicy(
    {
      https_proxy: "http://user:secret@127.0.0.1:8123",
      NO_PROXY: "example.invalid",
    },
    "darwin",
    () => {
      throw new Error("不得覆盖环境配置");
    },
  );
  assert.deepEqual(explicit.network, {
    source: "environment",
    proxyOrigin: "http://127.0.0.1:8123",
  });
  assert.equal(
    explicit.proxyEnv?.no_proxy,
    "example.invalid,localhost,127.0.0.1,::1",
  );
});

test("显式禁用代理或无代理平台保持直连，无效代理不静默回退另一链路", () => {
  assert.equal(
    modelNetworkPolicy(
      { NODE_USE_ENV_PROXY: "0", HTTPS_PROXY: "http://unused" },
      "darwin",
      () => {
        throw new Error("不得读取系统代理");
      },
    ).network.source,
    "direct",
  );
  assert.equal(
    modelNetworkPolicy({}, "linux", () => {
      throw new Error("不得执行macOS命令");
    }).network.source,
    "direct",
  );
  assert.equal(
    modelNetworkPolicy({}, "darwin", () => "HTTPSEnable : 0").network.source,
    "direct",
  );
  assert.throws(
    () =>
      modelNetworkPolicy(
        { HTTPS_PROXY: "socks5://secret@localhost:7897" },
        "darwin",
        () => system,
      ),
    /HTTP\/HTTPS/,
  );
  assert.throws(
    () =>
      modelNetworkPolicy(
        {},
        "darwin",
        () => "HTTPSEnable : 1\nHTTPSProxy : localhost\nHTTPSPort : 0",
      ),
    /端口无效/,
  );
});

test("默认DeepSeek客户端实际使用显式代理且只请求一次，隔离本机服务绕过代理", async () => {
  const connects: string[] = [];
  let local = 0;
  const server = createServer((_req, res) => {
    local++;
    res.end("isolated-local");
  });
  server.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    socket.end(
      "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const a = server.address();
    if (!a || typeof a === "string") throw new Error("缺少本机端口");
    const moduleUrl = new URL(
      "../../src/evolution/deepseek.ts",
      import.meta.url,
    ).href;
    const script = `import { DeepSeek } from ${JSON.stringify(moduleUrl)};
      let error;
      try { await new DeepSeek('synthetic-key').generate({instruction:'synthetic',history:[],message:'synthetic'},AbortSignal.timeout(3000)); }
      catch(e) {error={message:e.message,transport:e.transport};}
      const local = await fetch('http://127.0.0.1:${a.port}/isolated',{signal:AbortSignal.timeout(3000)}).then(r=>r.text());
      console.log(JSON.stringify({error,local}));`;
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: "",
          https_proxy: "",
          http_proxy: "",
          HTTP_PROXY: "",
          HTTPS_PROXY: `http://127.0.0.1:${a.port}`,
          NO_PROXY: "example.invalid",
          no_proxy: "",
        },
        timeout: 10000,
      },
    );
    const body = JSON.parse(result.stdout);
    assert.equal(body.error.transport.network.source, "environment");
    assert.equal(
      body.error.transport.network.proxyOrigin,
      `http://127.0.0.1:${a.port}`,
    );
    assert.equal(body.local, "isolated-local");
    assert.deepEqual(connects, ["api.deepseek.com:443"]);
    assert.equal(local, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const [code, kind] of [
  ["ENOTFOUND", "dns"],
  ["UND_ERR_CONNECT_TIMEOUT", "timeout"],
  ["CERT_HAS_EXPIRED", "tls"],
  ["ECONNRESET", "connection"],
] as const)
  test(`传输错误保留${code}分类和嵌套原因，不泄漏密钥或代理凭据`, async () => {
    const cause = Object.assign(
      new Error("https://user:proxy-secret@localhost/path?key=synthetic-key"),
      { code },
    );
    const g = new DeepSeek("synthetic-key", async () => {
      throw new TypeError("fetch failed", { cause });
    });
    await assert.rejects(
      g.generate(
        { instruction: "合成", history: [], message: "合成" },
        new AbortController().signal,
      ),
      (error) => {
        assert.ok(error instanceof ModelTransportError);
        assert.equal(error.transport.failure?.kind, kind);
        assert.ok(error.transport.failure.causes.some((c) => c.code === code));
        assert.ok(!JSON.stringify(error.transport).includes("synthetic-key"));
        assert.ok(!JSON.stringify(error.transport).includes("proxy-secret"));
        return true;
      },
    );
  });
