import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic.js";
import { GED_DIR } from "./contracts.js";

export const GED_STANDARD_VERSION = 3;
const VERSION_PATH = path.join(GED_DIR, "VERSION");
const IMPORT_STATE_PATH = path.join(GED_DIR, "IMPORT-STATE.json");
const STANDARDS_PATH = path.join(GED_DIR, "STANDARDS.md");

interface ImportState {
  accepted: ImportReference[];
  rejected: ImportReference[];
  pending: ImportReference[];
  standardsHash: string | null;
}

interface ImportReference {
  path: string;
  hash: string;
}

export interface DiscoveredStandard {
  path: string;
  scope: "repo" | "scoped";
  kind: string;
  summary: string;
  hash: string;
}

export interface StandardsImportResult {
  discovered: DiscoveredStandard[];
  pending: DiscoveredStandard[];
  accepted: DiscoveredStandard[];
  rejected: DiscoveredStandard[];
  promptNeeded: boolean;
}

interface ConfirmUI {
  confirm(title: string, message: string): Promise<boolean>;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function summarize(content: string): string {
  const paragraph = content
    .split(/\n\s*\n/u)
    .map((part) =>
      part
        .replace(/^#+\s*/gmu, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .find(Boolean);
  if (!paragraph) {
    return "No summary available.";
  }
  return paragraph.length > 180 ? `${paragraph.slice(0, 180)}…` : paragraph;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readDiscoveredFile(
  rootDir: string,
  relativePath: string,
  scope: "repo" | "scoped",
  kind: string,
): Promise<DiscoveredStandard | null> {
  const absolutePath = path.join(rootDir, relativePath);
  const content = await readOptional(absolutePath);
  if (!content?.trim()) {
    return null;
  }
  return {
    path: relativePath,
    scope,
    kind,
    summary: summarize(content),
    hash: hashContent(content),
  };
}

async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(absolute)));
    } else if (entry.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

async function discoverScopedFiles(
  rootDir: string,
  relativeDir: string,
  filter: (relativePath: string) => boolean,
  kind: string,
): Promise<DiscoveredStandard[]> {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!(await pathExists(absoluteDir))) {
    return [];
  }
  const files = await walkFiles(absoluteDir);
  const discovered = await Promise.all(
    files
      .map((absolutePath) => path.relative(rootDir, absolutePath))
      .filter(filter)
      .map((relativePath) =>
        readDiscoveredFile(rootDir, relativePath, "scoped", kind),
      ),
  );
  return discovered.filter(
    (value): value is DiscoveredStandard => value != null,
  );
}

export async function scanExternalStandards(
  rootDir: string,
): Promise<DiscoveredStandard[]> {
  const repoWideCandidates: Array<{ path: string; kind: string }> = [
    { path: "AGENTS.md", kind: "agents" },
    { path: "AGENTS.override.md", kind: "agents-override" },
    { path: "CLAUDE.md", kind: "claude" },
    { path: "GEMINI.md", kind: "gemini" },
    { path: ".github/copilot-instructions.md", kind: "copilot" },
    { path: ".cursorrules", kind: "cursor" },
  ];

  const repoWide = await Promise.all(
    repoWideCandidates.map((candidate) =>
      readDiscoveredFile(rootDir, candidate.path, "repo", candidate.kind),
    ),
  );

  const scoped = (
    await Promise.all([
      discoverScopedFiles(
        rootDir,
        ".github/instructions",
        (relativePath) => relativePath.endsWith(".instructions.md"),
        "copilot-scoped",
      ),
      discoverScopedFiles(
        rootDir,
        ".cursor/rules",
        (relativePath) => relativePath.endsWith(".mdc"),
        "cursor-scoped",
      ),
      discoverScopedFiles(rootDir, ".windsurf/rules", () => true, "windsurf"),
      discoverScopedFiles(rootDir, ".continue/rules", () => true, "continue"),
    ])
  ).flat();

  const seen = new Set<string>();
  return [...repoWide, ...scoped]
    .filter((value): value is DiscoveredStandard => value != null)
    .filter((entry) => {
      const key = `${entry.path}:${entry.hash}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

async function readImportState(rootDir: string): Promise<ImportState> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(rootDir, IMPORT_STATE_PATH), "utf8"),
    ) as Partial<ImportState>;
    const normalize = (value: unknown): ImportReference[] =>
      Array.isArray(value)
        ? value.flatMap((entry) => {
            if (typeof entry === "string") {
              return [{ path: entry, hash: "legacy-unbound" }];
            }
            if (
              entry &&
              typeof entry === "object" &&
              typeof (entry as ImportReference).path === "string" &&
              typeof (entry as ImportReference).hash === "string"
            ) {
              return [entry as ImportReference];
            }
            return [];
          })
        : [];
    return {
      accepted: normalize(parsed.accepted),
      rejected: normalize(parsed.rejected),
      pending: normalize(parsed.pending),
      standardsHash:
        typeof parsed.standardsHash === "string" ? parsed.standardsHash : null,
    };
  } catch {
    return {
      accepted: [],
      rejected: [],
      pending: [],
      standardsHash: null,
    };
  }
}

async function writeImportState(
  rootDir: string,
  state: ImportState,
): Promise<void> {
  await mkdir(path.join(rootDir, GED_DIR), { recursive: true });
  await writeFileAtomic(
    path.join(rootDir, IMPORT_STATE_PATH),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

async function syncAcceptedStandards(
  rootDir: string,
  acceptedReferences: ImportReference[],
): Promise<string | null> {
  const sections = await Promise.all(
    acceptedReferences.map(async (reference) => {
      const content = await readOptional(path.join(rootDir, reference.path));
      if (!content?.trim()) {
        return null;
      }
      if (hashContent(content) !== reference.hash) {
        return null;
      }
      let marker = `GED_APPROVED_${reference.hash.toUpperCase()}`;
      while (content.includes(marker)) marker += "_X";
      return `## ${reference.path}\n\nApproved content hash: ${reference.hash}\n\n<<<${marker}:BEGIN>>>\n${content}${content.endsWith("\n") ? "" : "\n"}<<<${marker}:END>>>\n`;
    }),
  );

  const body = sections.filter(Boolean).join("\n");
  if (!body) return null;
  const next = `# Imported Standards

These standards were imported from other harness-specific instruction files and approved for Ged use.

${body.trimEnd()}
`;
  await writeFileAtomic(path.join(rootDir, STANDARDS_PATH), next);
  return hashContent(next);
}

export async function readVerifiedApprovedStandards(
  rootDir: string,
): Promise<string | null> {
  const state = await readImportState(rootDir);
  if (!state.standardsHash) return null;
  const content = await readOptional(path.join(rootDir, STANDARDS_PATH));
  if (!content || hashContent(content) !== state.standardsHash) return null;
  return content;
}

function buildConfirmationMessage(candidates: DiscoveredStandard[]): string {
  const lines = candidates
    .slice(0, 6)
    .map((candidate) => `- ${candidate.path}: ${candidate.summary}`);
  const extra =
    candidates.length > 6 ? `\n- +${candidates.length - 6} more files` : "";
  return `Ged found external instruction files that could be kept as durable Ged standards.\n\n${lines.join("\n")}${extra}\n\nImport the repo-wide standards into .ged/STANDARDS.md now?`;
}

export async function resolveImportedStandards(
  rootDir: string,
  ui?: ConfirmUI,
): Promise<StandardsImportResult> {
  const discovered = await scanExternalStandards(rootDir);
  const repoWide = discovered.filter((entry) => entry.scope === "repo");
  const state = await readImportState(rootDir);

  const referenceKey = (entry: ImportReference) =>
    `${entry.path}\0${entry.hash}`;
  const known = new Set(
    [...state.accepted, ...state.rejected].map(referenceKey),
  );
  const newlyPending = repoWide.filter(
    (entry) => !known.has(referenceKey(entry)),
  );
  let accepted = repoWide.filter((entry) =>
    state.accepted.some(
      (reference) => referenceKey(reference) === referenceKey(entry),
    ),
  );
  let rejected = repoWide.filter((entry) =>
    state.rejected.some(
      (reference) => referenceKey(reference) === referenceKey(entry),
    ),
  );
  let pending = repoWide.filter((entry) =>
    state.pending.some(
      (reference) => referenceKey(reference) === referenceKey(entry),
    ),
  );

  if (newlyPending.length > 0) {
    pending = [...pending, ...newlyPending];
    state.pending = [
      ...state.pending,
      ...newlyPending.map(({ path: candidatePath, hash }) => ({
        path: candidatePath,
        hash,
      })),
    ].filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) => referenceKey(candidate) === referenceKey(entry),
        ) === index,
    );
  }

  if (ui && pending.length > 0) {
    const confirmed = await ui.confirm(
      "Import external standards?",
      buildConfirmationMessage(pending),
    );
    if (confirmed) {
      const pendingPaths = new Set(pending.map((entry) => entry.path));
      state.accepted = [
        ...state.accepted.filter(
          (reference) => !pendingPaths.has(reference.path),
        ),
        ...pending.map(({ path: candidatePath, hash }) => ({
          path: candidatePath,
          hash,
        })),
      ];
      accepted = repoWide.filter((entry) =>
        state.accepted.some(
          (reference) => referenceKey(reference) === referenceKey(entry),
        ),
      );
    } else {
      const pendingPaths = new Set(pending.map((entry) => entry.path));
      state.rejected = [
        ...state.rejected.filter(
          (reference) => !pendingPaths.has(reference.path),
        ),
        ...pending.map(({ path: candidatePath, hash }) => ({
          path: candidatePath,
          hash,
        })),
      ];
      rejected = repoWide.filter((entry) =>
        state.rejected.some(
          (reference) => referenceKey(reference) === referenceKey(entry),
        ),
      );
    }
    state.pending = [];
    pending = [];
  }

  const standardsHash = await syncAcceptedStandards(rootDir, state.accepted);
  if (standardsHash) {
    state.standardsHash = standardsHash;
  } else if (state.standardsHash) {
    const existing = await readOptional(path.join(rootDir, STANDARDS_PATH));
    if (!existing || hashContent(existing) !== state.standardsHash) {
      state.standardsHash = null;
    }
  }
  await writeImportState(rootDir, state);

  return {
    discovered,
    pending,
    accepted,
    rejected,
    promptNeeded: pending.length > 0,
  };
}

export async function readGedVersion(rootDir: string): Promise<number | null> {
  const content = await readOptional(path.join(rootDir, VERSION_PATH));
  if (!content) {
    return null;
  }
  // Accept the integer version as the only file content (with optional
  // trailing newline / whitespace). Refuse files like "1abc", "1 2", or
  // "v1" so a corrupted or unrelated file can't be silently treated as
  // a valid Ged standard version.
  const trimmed = content.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function writeGedVersion(rootDir: string): Promise<void> {
  await mkdir(path.join(rootDir, GED_DIR), { recursive: true });
  await writeFileAtomic(
    path.join(rootDir, VERSION_PATH),
    `${GED_STANDARD_VERSION}\n`,
  );
}

export async function ensureIgnoredInGitignore(
  rootDir: string,
  ignoredEntry: string,
): Promise<boolean> {
  if (!(await pathExists(path.join(rootDir, ".git")))) {
    return false;
  }

  const gitignorePath = path.join(rootDir, ".gitignore");
  const existing = (await readOptional(gitignorePath)) ?? "";
  const entries = existing
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (entries.includes(ignoredEntry)) {
    return false;
  }

  const prefix = existing.trimEnd();
  const next =
    prefix.length > 0 ? `${prefix}\n${ignoredEntry}\n` : `${ignoredEntry}\n`;
  await writeFileAtomic(gitignorePath, next);
  return true;
}

export async function ensurePiIgnoredInGitignore(
  rootDir: string,
): Promise<boolean> {
  return ensureIgnoredInGitignore(rootDir, ".pi/");
}
