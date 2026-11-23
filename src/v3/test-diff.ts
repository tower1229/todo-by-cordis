import { artifactKey } from "./topology.js";
import type { CompositionSnapshot, PluginArtifact } from "./types.js";

export interface TestFileDiffEntry {
  readonly file: string;
  readonly status: "modified" | "added" | "removed";
  readonly affectedTestCases: readonly string[];
  readonly diffSummary: string;
}

export interface TestChangeDisclosure {
  readonly pluginId: string;
  readonly modifiedFiles: readonly string[];
  readonly addedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly fileDiffs: readonly TestFileDiffEntry[];
}

interface DiffOp {
  readonly kind: "equal" | "delete" | "insert";
  readonly line: string;
  readonly oldIndex: number; // 0-based line index in old (or -1)
  readonly newIndex: number; // 0-based line index in new (or -1)
}

interface NamedBlock {
  readonly name: string;
  readonly startLine: number;
  readonly endLine: number;
}

const TEST_CALL_RE = /\b(?:it|test|describe)\s*\(\s*(['"`])([^'"`]+)\1/;
const NAMED_FN_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/;
const DEFAULT_EXPORT_FN_RE = /^\s*export\s+default\s+(?:async\s+)?function\b/;

function extractNamedBlocks(lines: readonly string[]): NamedBlock[] {
  const markers: Array<{ name: string; startLine: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const callMatch = TEST_CALL_RE.exec(line);
    if (callMatch) {
      markers.push({ name: callMatch[2], startLine: i });
      continue;
    }
    const fnMatch = NAMED_FN_RE.exec(line);
    if (fnMatch) {
      markers.push({ name: fnMatch[1], startLine: i });
      continue;
    }
    if (DEFAULT_EXPORT_FN_RE.test(line)) {
      markers.push({ name: "default", startLine: i });
    }
  }

  return markers.map((marker, idx) => ({
    name: marker.name,
    startLine: marker.startLine,
    endLine:
      idx + 1 < markers.length ? markers[idx + 1].startLine - 1 : lines.length - 1,
  }));
}

function computeLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;

  // Guard against huge files with a simple prefix/suffix fallback
  if (n * m > 200_000) {
    let prefix = 0;
    while (prefix < n && prefix < m && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }
    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      oldLines[n - 1 - suffix] === newLines[m - 1 - suffix]
    ) {
      suffix++;
    }
    const ops: DiffOp[] = [];
    for (let i = 0; i < prefix; i++) {
      ops.push({ kind: "equal", line: oldLines[i], oldIndex: i, newIndex: i });
    }
    for (let i = prefix; i < n - suffix; i++) {
      ops.push({ kind: "delete", line: oldLines[i], oldIndex: i, newIndex: -1 });
    }
    for (let j = prefix; j < m - suffix; j++) {
      ops.push({ kind: "insert", line: newLines[j], oldIndex: -1, newIndex: j });
    }
    for (let k = 0; k < suffix; k++) {
      ops.push({
        kind: "equal",
        line: oldLines[n - suffix + k],
        oldIndex: n - suffix + k,
        newIndex: m - suffix + k,
      });
    }
    return ops;
  }

  // Standard LCS DP table
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "equal", line: oldLines[i], oldIndex: i, newIndex: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "delete", line: oldLines[i], oldIndex: i, newIndex: -1 });
      i++;
    } else {
      ops.push({ kind: "insert", line: newLines[j], oldIndex: -1, newIndex: j });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "delete", line: oldLines[i], oldIndex: i, newIndex: -1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "insert", line: newLines[j], oldIndex: -1, newIndex: j });
    j++;
  }
  return ops;
}

function formatDiffSummary(ops: readonly DiffOp[], maxLines = 40): string {
  const changedIndices = new Set<number>();
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx].kind !== "equal") {
      if (idx > 0) changedIndices.add(idx - 1);
      changedIndices.add(idx);
      if (idx + 1 < ops.length) changedIndices.add(idx + 1);
    }
  }

  const out: string[] = [];
  let prevIncluded = -2;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!changedIndices.has(idx)) continue;
    if (prevIncluded >= 0 && idx > prevIncluded + 1) {
      out.push("...");
    }
    const op = ops[idx];
    const prefix = op.kind === "delete" ? "-" : op.kind === "insert" ? "+" : " ";
    out.push(`${prefix}${op.line}`);
    prevIncluded = idx;
    if (out.length >= maxLines) {
      out.push("... (truncated)");
      break;
    }
  }
  return out.join("\n");
}

function buildModifiedFileDiff(
  file: string,
  oldContent: string,
  newContent: string,
): TestFileDiffEntry {
  const oldLines = oldContent.split(/\r?\n/);
  const newLines = newContent.split(/\r?\n/);
  const ops = computeLineDiff(oldLines, newLines);

  const oldBlocks = extractNamedBlocks(oldLines);
  const newBlocks = extractNamedBlocks(newLines);
  const affected = new Set<string>();

  for (const op of ops) {
    if (op.kind === "delete" && op.oldIndex >= 0) {
      for (const block of oldBlocks) {
        if (op.oldIndex >= block.startLine && op.oldIndex <= block.endLine) {
          affected.add(block.name);
        }
      }
    } else if (op.kind === "insert" && op.newIndex >= 0) {
      for (const block of newBlocks) {
        if (op.newIndex >= block.startLine && op.newIndex <= block.endLine) {
          affected.add(block.name);
        }
      }
    }
  }

  return {
    file,
    status: "modified",
    affectedTestCases: [...affected].sort(),
    diffSummary: formatDiffSummary(ops),
  };
}

export function diffPluginTestFiles(
  pluginId: string,
  baselineTests: Readonly<Record<string, string>>,
  candidateTests: Readonly<Record<string, string>>,
): TestChangeDisclosure | null {
  const modifiedFiles: string[] = [];
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];
  const fileDiffs: TestFileDiffEntry[] = [];

  const allFiles = new Set([
    ...Object.keys(baselineTests),
    ...Object.keys(candidateTests),
  ]);
  const sortedFiles = [...allFiles].sort();

  for (const file of sortedFiles) {
    const inBase = file in baselineTests;
    const inCand = file in candidateTests;
    if (inBase && !inCand) {
      removedFiles.push(file);
      const oldLines = baselineTests[file].split(/\r?\n/);
      const blocks = extractNamedBlocks(oldLines);
      fileDiffs.push({
        file,
        status: "removed",
        affectedTestCases: [...new Set(blocks.map((b) => b.name))].sort(),
        diffSummary: oldLines
          .slice(0, 20)
          .map((l) => `-${l}`)
          .join("\n"),
      });
    } else if (!inBase && inCand) {
      addedFiles.push(file);
      const newLines = candidateTests[file].split(/\r?\n/);
      const blocks = extractNamedBlocks(newLines);
      fileDiffs.push({
        file,
        status: "added",
        affectedTestCases: [...new Set(blocks.map((b) => b.name))].sort(),
        diffSummary: newLines
          .slice(0, 20)
          .map((l) => `+${l}`)
          .join("\n"),
      });
    } else if (inBase && inCand && baselineTests[file] !== candidateTests[file]) {
      modifiedFiles.push(file);
      fileDiffs.push(
        buildModifiedFileDiff(file, baselineTests[file], candidateTests[file]),
      );
    }
  }

  if (fileDiffs.length === 0) {
    return null;
  }

  return {
    pluginId,
    modifiedFiles,
    addedFiles,
    removedFiles,
    fileDiffs,
  };
}

export function computeTestChangeDisclosures(
  baseline: CompositionSnapshot | undefined,
  candidate: CompositionSnapshot,
  artifacts: ReadonlyMap<string, PluginArtifact>,
): TestChangeDisclosure[] {
  if (!baseline) return [];

  const baselineById = new Map(baseline.members.map((m) => [m.pluginId, m]));
  const disclosures: TestChangeDisclosure[] = [];

  for (const candMember of candidate.members) {
    const baseMember = baselineById.get(candMember.pluginId);
    if (!baseMember) continue; // newly added plugin, not an existing plugin
    if (baseMember.versionId === candMember.versionId) continue;

    const baseArtifact = artifacts.get(
      artifactKey(baseMember.pluginId, baseMember.versionId),
    );
    const candArtifact = artifacts.get(
      artifactKey(candMember.pluginId, candMember.versionId),
    );
    const disclosure = diffPluginTestFiles(
      candMember.pluginId,
      baseArtifact?.testFiles ?? {},
      candArtifact?.testFiles ?? {},
    );
    if (disclosure) {
      disclosures.push(disclosure);
    }
  }

  return disclosures.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}
