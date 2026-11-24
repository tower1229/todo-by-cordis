import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { build as viteBuild } from "vite";
import { resolveProjectRoot } from "../../build/project-root.js";
import { promoteResponsiveUtilityLayers } from "../../build/tailwind-compiler.js";

const require = createRequire(import.meta.url);

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
export const IMPORTMAP_ENTRIES: Readonly<Record<string, string>> = {
  react: "vendor-react.mjs",
  "react-dom": "vendor-react-dom.mjs",
  "react-dom/client": "vendor-react-dom-client.mjs",
  "react/jsx-runtime": "vendor-react-jsx-runtime.mjs",
  cordis: "vendor-cordis.mjs",
  "lucide-react": "vendor-lucide-react.mjs",
  "@base-ui/react": "vendor-base-ui-react.mjs",
  "@host/client-sdk": "client-sdk.mjs",
};

export const IMPORTMAP_SPECIFIERS: readonly string[] = Object.keys(
  IMPORTMAP_ENTRIES,
);

const REQUIRED_OUTPUT_FILES = [
  ...Object.values(IMPORTMAP_ENTRIES),
  "host-main.mjs",
  "host.css",
];

function collectFilesRecursively(
  projectRoot: string,
  relTarget: string,
  out: string[],
): void {
  const full = join(projectRoot, relTarget);
  if (!existsSync(full)) return;
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const entry of readdirSync(full).sort()) {
      collectFilesRecursively(projectRoot, join(relTarget, entry), out);
    }
  } else if (st.isFile()) {
    out.push(relative(projectRoot, full).replace(/\\/g, "/"));
  }
}

export function computeSourceStamp(projectRoot: string): string {
  const roots = [
    "package.json",
    "src/contracts",
    "src/runtime/client",
    "src/build/tailwind-compiler.ts",
    "src/supervisor/ui",
  ];
  const trackedFiles: string[] = [];
  for (const root of roots) {
    collectFilesRecursively(projectRoot, root, trackedFiles);
  }
  trackedFiles.sort();
  const hash = createHash("sha256");
  for (const rel of trackedFiles) {
    const full = join(projectRoot, rel);
    const st = statSync(full);
    hash.update(`${rel}:${st.size}:${Math.trunc(st.mtimeMs)}\n`);
  }
  return hash.digest("hex").slice(0, 16);
}

const inflightBuilds = new Map<string, Promise<string>>();

export function getDefaultClientAssetsDir(): string {
  return join(resolveProjectRoot(), "dist", "client");
}

export async function ensureClientAssets(options?: {
  readonly outDir?: string;
  readonly force?: boolean;
}): Promise<string> {
  const projectRoot = resolveProjectRoot();
  const outDir = resolve(options?.outDir ?? getDefaultClientAssetsDir());
  const stampFile = join(outDir, ".build-stamp");
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
      "virtual:host-vendor-react": buildCjsReexportWrapper("react"),
      "virtual:host-vendor-react-dom": buildCjsReexportWrapper("react-dom"),
      "virtual:host-vendor-react-dom-client":
        buildCjsReexportWrapper("react-dom/client"),
      "virtual:host-vendor-react-jsx-runtime":
        buildCjsReexportWrapper("react/jsx-runtime"),
      "virtual:host-vendor-cordis": 'export * from "cordis";\n',
      "virtual:host-vendor-lucide-react": 'export * from "lucide-react";\n',
      "virtual:host-vendor-base-ui-react": 'export * from "@base-ui/react";\n',
    };

    const clientSdkEntry = join(projectRoot, "src/contracts/client-sdk.ts");
    const mainEntry = join(projectRoot, "src/supervisor/ui/main.tsx");

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
          name: "host-virtual-vendor-entries",
          resolveId(id) {
            if (id in virtualEntries) {
              return `\0${id}`;
            }
            return null;
          },
          load(id) {
            if (id.startsWith("\0virtual:host-vendor-")) {
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
            "vendor-react": "virtual:host-vendor-react",
            "vendor-react-dom": "virtual:host-vendor-react-dom",
            "vendor-react-dom-client": "virtual:host-vendor-react-dom-client",
            "vendor-react-jsx-runtime": "virtual:host-vendor-react-jsx-runtime",
            "vendor-cordis": "virtual:host-vendor-cordis",
            "vendor-lucide-react": "virtual:host-vendor-lucide-react",
            "vendor-base-ui-react": "virtual:host-vendor-base-ui-react",
            "client-sdk": clientSdkEntry,
            "host-main": mainEntry,
          },
          output: {
            format: "es",
            entryFileNames: "[name].mjs",
            chunkFileNames: "chunks/[name]-[hash].mjs",
            assetFileNames: (assetInfo) => {
              const names = assetInfo.names ?? [];
              if (names.some((name) => name.endsWith(".css"))) {
                return "host.css";
              }
              return "assets/[name]-[hash][extname]";
            },
          },
        },
      },
    });

    const hostCssPath = join(outDir, "host.css");
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

export function buildHostImportMap(assetBaseUrl = "/assets/host"): {
  readonly imports: Readonly<Record<string, string>>;
} {
  const base = assetBaseUrl.replace(/\/+$/, "");
  const imports: Record<string, string> = {};
  for (const [specifier, fileName] of Object.entries(IMPORTMAP_ENTRIES)) {
    imports[specifier] = `${base}/${fileName}`;
  }
  return { imports };
}

export function renderHostHtml(options?: {
  readonly title?: string;
  readonly assetBaseUrl?: string;
}): string {
  const title = options?.title ?? "Cordis Self-Iteration Host";
  const base = (options?.assetBaseUrl ?? "/assets/host").replace(/\/+$/, "");
  const importMapJson = JSON.stringify(buildHostImportMap(base), null, 2);

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
    <link rel="stylesheet" href="${base}/host.css" />
  </head>
  <body>
    <div id="supervisor-root"></div>
    <div id="app-root"></div>
    <script type="module" src="${base}/host-main.mjs"></script>
  </body>
</html>
`;
}
