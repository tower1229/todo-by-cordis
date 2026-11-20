import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build as viteBuild } from "vite";
import { promoteResponsiveUtilityLayers } from "./tailwind-compiler.js";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function resolveProjectRoot(): string {
  // Works both from src/v3/*.ts and dist/v3/*.js
  let dir = __dirname;
  for (let i = 0; i < 5; i += 1) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return process.cwd();
}

const VALID_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const RESERVED_WORDS = new Set([
  "default",
  "delete",
  "export",
  "import",
  "return",
  "switch",
  "typeof",
  "void",
  "class",
  "const",
  "let",
  "var",
  "function",
  "new",
  "this",
  "super",
  "in",
  "instanceof",
]);

function buildCjsReexportWrapper(specifier: string): string {
  const mod = require(specifier) as Record<string, unknown>;
  const keys = Object.keys(mod).filter(
    (k) => VALID_IDENTIFIER_RE.test(k) && !RESERVED_WORDS.has(k),
  );
  if (keys.length === 0) {
    return `import _mod from ${JSON.stringify(specifier)};\nexport default _mod;\n`;
  }
  return [
    `import _mod from ${JSON.stringify(specifier)};`,
    `export default _mod;`,
    `export const { ${keys.join(", ")} } = _mod;`,
  ].join("\n");
}

/**
 * Single source of truth for browser importmap singleton specifiers.
 */
export const V3_IMPORTMAP_ENTRIES: Readonly<Record<string, string>> = {
  react: "vendor-react.mjs",
  "react-dom": "vendor-react-dom.mjs",
  "react-dom/client": "vendor-react-dom-client.mjs",
  "react/jsx-runtime": "vendor-react-jsx-runtime.mjs",
  cordis: "vendor-cordis.mjs",
  "lucide-react": "vendor-lucide-react.mjs",
  "@base-ui/react": "vendor-base-ui-react.mjs",
  "@host/client-sdk": "client-sdk.mjs",
};

export const V3_IMPORTMAP_SPECIFIERS: readonly string[] = Object.keys(
  V3_IMPORTMAP_ENTRIES,
);

const REQUIRED_OUTPUT_FILES = [
  ...Object.values(V3_IMPORTMAP_ENTRIES),
  "v3-main.mjs",
  "v3-host.css",
];

function computeSourceStamp(projectRoot: string): string {
  const trackedFiles = [
    "package.json",
    "src/v3/types.ts",
    "src/v3/topology.ts",
    "src/v3/v3-theme.css",
    "src/v3/client-sdk.ts",
    "src/v3/tailwind-compiler.ts",
    "src/v3/client-bundle-builder.ts",
    "src/v3/client/client-runtime.ts",
    "src/v3/client/supervisor-shell.tsx",
    "src/v3/client/app-host.tsx",
    "src/v3/client/host-base.css",
    "src/v3/client/main.tsx",
  ];
  const hash = createHash("sha256");
  for (const rel of trackedFiles) {
    const full = join(projectRoot, rel);
    if (!existsSync(full)) continue;
    const st = statSync(full);
    hash.update(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

const inflightBuilds = new Map<string, Promise<string>>();

export function getDefaultV3ClientAssetsDir(): string {
  return join(resolveProjectRoot(), "dist", "v3-client");
}

export async function ensureV3ClientAssets(options?: {
  readonly outDir?: string;
  readonly force?: boolean;
}): Promise<string> {
  const projectRoot = resolveProjectRoot();
  const outDir = resolve(options?.outDir ?? getDefaultV3ClientAssetsDir());
  const stampFile = join(outDir, ".v3-build-stamp");
  const currentStamp = computeSourceStamp(projectRoot);

  if (
    !options?.force &&
    existsSync(stampFile) &&
    readFileSync(stampFile, "utf8").trim() === currentStamp &&
    REQUIRED_OUTPUT_FILES.every((f) => existsSync(join(outDir, f)))
  ) {
    return outDir;
  }

  const existingPromise = inflightBuilds.get(outDir);
  if (existingPromise) {
    return existingPromise;
  }

  const buildPromise = (async () => {
    const virtualEntries: Record<string, string> = {
      "virtual:v3-vendor-react": buildCjsReexportWrapper("react"),
      "virtual:v3-vendor-react-dom": buildCjsReexportWrapper("react-dom"),
      "virtual:v3-vendor-react-dom-client":
        buildCjsReexportWrapper("react-dom/client"),
      "virtual:v3-vendor-react-jsx-runtime":
        buildCjsReexportWrapper("react/jsx-runtime"),
      "virtual:v3-vendor-cordis": 'export * from "cordis";\n',
      "virtual:v3-vendor-lucide-react": 'export * from "lucide-react";\n',
      "virtual:v3-vendor-base-ui-react": 'export * from "@base-ui/react";\n',
    };

    const clientSdkEntry = join(projectRoot, "src/v3/client-sdk.ts");
    const mainEntry = join(projectRoot, "src/v3/client/main.tsx");

    await viteBuild({
      configFile: false,
      root: projectRoot,
      logLevel: "silent",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      resolve: {
        alias: {
          "@host/client-sdk": clientSdkEntry,
        },
      },
      plugins: [
        react(),
        tailwindcss(),
        {
          name: "v3-virtual-vendor-entries",
          resolveId(id) {
            if (id in virtualEntries) {
              return `\0${id}`;
            }
            return null;
          },
          load(id) {
            if (id.startsWith("\0virtual:v3-vendor-")) {
              return virtualEntries[id.slice(1)] ?? null;
            }
            return null;
          },
        },
      ],
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        cssCodeSplit: false,
        rollupOptions: {
          preserveEntrySignatures: "strict",
          input: {
            "vendor-react": "virtual:v3-vendor-react",
            "vendor-react-dom": "virtual:v3-vendor-react-dom",
            "vendor-react-dom-client": "virtual:v3-vendor-react-dom-client",
            "vendor-react-jsx-runtime": "virtual:v3-vendor-react-jsx-runtime",
            "vendor-cordis": "virtual:v3-vendor-cordis",
            "vendor-lucide-react": "virtual:v3-vendor-lucide-react",
            "vendor-base-ui-react": "virtual:v3-vendor-base-ui-react",
            "client-sdk": clientSdkEntry,
            "v3-main": mainEntry,
          },
          output: {
            format: "es",
            entryFileNames: "[name].mjs",
            chunkFileNames: "chunks/[name]-[hash].mjs",
            assetFileNames: (assetInfo) => {
              const names = assetInfo.names ?? [];
              if (names.some((name) => name.endsWith(".css"))) {
                return "v3-host.css";
              }
              return "assets/[name]-[hash][extname]";
            },
          },
        },
      },
    });

    const hostCssPath = join(outDir, "v3-host.css");
    if (existsSync(hostCssPath)) {
      const hostCss = readFileSync(hostCssPath, "utf8");
      writeFileSync(
        hostCssPath,
        promoteResponsiveUtilityLayers(hostCss),
        "utf8",
      );
    }

    writeFileSync(stampFile, `${currentStamp}\n`, "utf8");
    return outDir;
  })().finally(() => {
    inflightBuilds.delete(outDir);
  });

  inflightBuilds.set(outDir, buildPromise);
  return buildPromise;
}

export function buildV3ImportMap(assetBaseUrl = "/assets/v3"): {
  readonly imports: Readonly<Record<string, string>>;
} {
  const base = assetBaseUrl.replace(/\/+$/, "");
  const imports: Record<string, string> = {};
  for (const [specifier, fileName] of Object.entries(V3_IMPORTMAP_ENTRIES)) {
    imports[specifier] = `${base}/${fileName}`;
  }
  return { imports };
}

export function renderV3HostHtml(options?: {
  readonly title?: string;
  readonly assetBaseUrl?: string;
}): string {
  const title = options?.title ?? "Cordis V3 App";
  const base = (options?.assetBaseUrl ?? "/assets/v3").replace(/\/+$/, "");
  const importMapJson = JSON.stringify(buildV3ImportMap(base), null, 2);

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#f7f8fa" />
    <title>${title}</title>
    <script type="importmap">
${importMapJson}
    </script>
    <link rel="stylesheet" href="${base}/v3-host.css" />
  </head>
  <body>
    <div id="supervisor-root"></div>
    <div id="app-root"></div>
    <script type="module" src="${base}/v3-main.mjs"></script>
  </body>
</html>
`;
}
