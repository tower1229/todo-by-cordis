import { parse } from "@babel/parser";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectRoot } from "../build/project-root.js";

const SERVER_SHARED_TYPE_NAMES = new Set<string>([
  "HttpMethod",
  "PluginManifest",
  "PluginArtifact",
  "ScopedStatement",
  "ScopedDb",
  "HttpDispatchInput",
  "AppRequest",
  "AppResponse",
  "RouteHandlerResult",
  "HttpRouter",
  "SchedulerService",
  "FiberStateName",
  "RouteDescriptor",
  "PluginTopologyEntry",
  "CompositionTopology",
  "ClientDiagnostic",
]);

const CORDIS_CONTEXT_TYPE_NAMES = new Set<string>([
  "HttpMethod",
  "ScopedStatement",
  "ScopedDb",
  "AppRequest",
  "AppResponse",
  "RouteHandlerResult",
  "HttpRouter",
  "SchedulerService",
]);

const CLIENT_SHARED_TYPE_NAMES = new Set<string>([
  "ActiveClientComposition",
  "ClientDiagnostic",
]);

const SERVER_SDK_PUBLIC_NAMES = new Set<string>([
  "PluginContractTestContext",
  "PluginTestContext",
  "dispatchServerBail",
]);

const CLIENT_SDK_PUBLIC_NAMES = new Set<string>([
  "SlotPropsMap",
  "SlotPropsFor",
  "ClientPageRegistration",
  "ClientRouter",
  "SlotRegistrationOptions",
  "SlotRegistry",
  "RegisteredClientPage",
  "Slot",
  "useClientContext",
  "useClientRoutes",
  "useCurrentPath",
  "useNavigate",
  "dispatchClientBail",
]);

interface AstNode {
  readonly type: string;
  readonly start?: number | null;
  readonly end?: number | null;
  readonly [key: string]: unknown;
}

function parseTsAst(source: string, isTsx = false): AstNode[] {
  const ast = parse(source, {
    sourceType: "module",
    plugins: isTsx ? ["typescript", "jsx"] : ["typescript"],
  });
  return (ast.program.body ?? []) as unknown as AstNode[];
}

function sliceNode(source: string, node: AstNode): string {
  if (typeof node.start !== "number" || typeof node.end !== "number") {
    return "";
  }
  return source.slice(node.start, node.end).trim();
}

function extractSelectedDeclarations(
  source: string,
  allowedNames: ReadonlySet<string>,
  isTsx = false,
): string[] {
  const out: string[] = [];
  for (const stmt of parseTsAst(source, isTsx)) {
    if (stmt.type !== "ExportNamedDeclaration" || !stmt.declaration) continue;
    const decl = stmt.declaration as AstNode;
    const id = decl.id as AstNode | undefined;
    const name = typeof id?.name === "string" ? id.name : undefined;
    if (!name || !allowedNames.has(name)) continue;

    if (
      decl.type === "TSInterfaceDeclaration" ||
      decl.type === "TSTypeAliasDeclaration"
    ) {
      out.push(sliceNode(source, stmt));
    } else if (decl.type === "FunctionDeclaration") {
      const body = decl.body as AstNode | undefined;
      if (typeof stmt.start !== "number" || typeof body?.start !== "number") {
        continue;
      }
      const params = Array.isArray(decl.params) ? (decl.params as AstNode[]) : [];
      const typeParams = decl.typeParameters as AstNode | undefined;
      const returnType = decl.returnType as AstNode | undefined;
      const formattedParams = params.map((param, idx) => {
        if (param.type === "ObjectPattern") {
          const typeAnn = param.typeAnnotation as AstNode | undefined;
          const typeStr = typeAnn
            ? sliceNode(source, typeAnn)
            : ": Record<string, unknown>";
          return `props${idx === 0 ? "" : idx}${typeStr}`;
        }
        return sliceNode(source, param);
      });
      const typeParamStr = typeParams ? sliceNode(source, typeParams) : "";
      const returnStr = returnType
        ? sliceNode(source, returnType)
        : name === "Slot"
          ? ': import("react").ReactElement | null'
          : ": unknown";
      out.push(
        `export function ${name}${typeParamStr}(${formattedParams.join(", ")})${returnStr};`,
      );
    }
  }
  return out;
}

function extractCordisContextMembers(source: string, isTsx = false): string[] {
  const members: string[] = [];
  for (const stmt of parseTsAst(source, isTsx)) {
    if (stmt.type !== "TSModuleDeclaration") continue;
    const id = stmt.id as AstNode | undefined;
    if (id?.type !== "StringLiteral" || id.value !== "cordis") continue;
    const block = stmt.body as AstNode | undefined;
    const body = Array.isArray(block?.body) ? (block.body as AstNode[]) : [];
    for (const inner of body) {
      if (inner.type !== "TSInterfaceDeclaration") continue;
      const ifaceId = inner.id as AstNode | undefined;
      if (ifaceId?.name !== "Context") continue;
      const ifaceBody = inner.body as AstNode | undefined;
      const ifaceMembers = Array.isArray(ifaceBody?.body)
        ? (ifaceBody.body as AstNode[])
        : [];
      for (const member of ifaceMembers) {
        members.push(sliceNode(source, member));
      }
    }
  }
  return members;
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n");
}

function qualifyExternalTypes(text: string): string {
  return text
    .replace(
      /(?<!import\("react"\)\.)\bComponentType\b/g,
      'import("react").ComponentType',
    )
    .replace(
      /(?<!import\("react"\)\.)\bReactElement\b/g,
      'import("react").ReactElement',
    )
    .replace(
      /(?<!import\("react"\)\.)\bReactNode\b/g,
      'import("react").ReactNode',
    )
    .replace(/(?<!import\("cordis"\)\.)\bContext\b/g, 'import("cordis").Context');
}

/**
 * Build the canonical Host SDK `.d.ts` reference directly from the real
 * TypeScript SDK source files so model-facing contracts can never drift from
 * the runtime implementation.
 */
export function buildHostSdkContracts(
  projectRoot: string = resolveProjectRoot(),
): string {
  const typesSource = readFileSync(
    join(projectRoot, "src/contracts/types.ts"),
    "utf8",
  );
  const serverSdkSource = readFileSync(
    join(projectRoot, "src/contracts/server-sdk.ts"),
    "utf8",
  );
  const clientSdkSource = readFileSync(
    join(projectRoot, "src/contracts/client-sdk.ts"),
    "utf8",
  );
  const runtimeBridgeSource = readFileSync(
    join(projectRoot, "src/runtime/client/runtime-bridge.ts"),
    "utf8",
  );
  const scopedDbSource = readFileSync(
    join(projectRoot, "src/runtime/server/scoped-db.ts"),
    "utf8",
  );

  const serverSharedTypes = extractSelectedDeclarations(
    typesSource,
    SERVER_SHARED_TYPE_NAMES,
  );
  const clientSharedTypes = extractSelectedDeclarations(
    typesSource,
    CLIENT_SHARED_TYPE_NAMES,
  );
  const cordisContextTypes = extractSelectedDeclarations(
    typesSource,
    CORDIS_CONTEXT_TYPE_NAMES,
  ).map((d) => d.replace(/^export\s+/, ""));

  const serverCordisMembers = extractCordisContextMembers(serverSdkSource);
  const clientCordisMembers = extractCordisContextMembers(clientSdkSource);

  const serverSdkDecls = [
    ...serverSharedTypes,
    ...extractSelectedDeclarations(scopedDbSource, new Set(["pluginTablePrefix"])),
    ...extractSelectedDeclarations(serverSdkSource, SERVER_SDK_PUBLIC_NAMES).map(
      qualifyExternalTypes,
    ),
  ];

  const clientSdkDecls = [
    ...clientSharedTypes,
    ...extractSelectedDeclarations(
      runtimeBridgeSource,
      new Set(["RegisteredClientPage"]),
    ),
    ...extractSelectedDeclarations(clientSdkSource, CLIENT_SDK_PUBLIC_NAMES),
  ].map(qualifyExternalTypes);

  return [
    "// Canonical Host SDK declarations (auto-derived from @host/server-sdk and @host/client-sdk)",
    'declare module "@host/server-sdk" {',
    indentBlock(serverSdkDecls.join("\n"), 2),
    "}",
    "",
    'declare module "@host/client-sdk" {',
    indentBlock(clientSdkDecls.join("\n"), 2),
    "}",
    "",
    'declare module "cordis" {',
    indentBlock(cordisContextTypes.join("\n"), 2),
    "  interface Context {",
    "    // Server-side services (server.ts)",
    ...serverCordisMembers.map((m) => `    ${m}`),
    "    // Client-side services (client.tsx)",
    ...clientCordisMembers.map(
      (m) =>
        `    ${m
          .replace(/\bClientRouter\b/g, 'import("@host/client-sdk").ClientRouter')
          .replace(
            /\bSlotRegistry\b/g,
            'import("@host/client-sdk").SlotRegistry',
          )}`,
    ),
    "  }",
    "}",
    "",
  ].join("\n");
}

let cachedContracts: string | null = null;

export function getHostSdkContracts(): string {
  if (cachedContracts === null) {
    cachedContracts = buildHostSdkContracts();
  }
  return cachedContracts;
}

export const HOST_SDK_CONTRACTS: string = getHostSdkContracts();
