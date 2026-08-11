import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publishFileExclusive, writeFileAtomic } from "./atomic.js";
import type { SkillCandidate, SkillPolicy, TaskBrief } from "./contracts.js";
import { assertSafeRepositoryWritePath } from "./path-safety.js";

export interface SkillSignal {
  label: string;
  packages?: string[];
  files?: string[];
  reason: string;
  policy?: SkillPolicy;
}

export const defaultSkillSignals: SkillSignal[] = [
  {
    label: "find-skills",
    reason: "Discover project-relevant skills during init and planning.",
    policy: "auto-install",
  },
  {
    label: "skill-creator",
    reason:
      "Create project-specific skills when Ged cannot find one that fits.",
    policy: "auto-install",
  },
  {
    label: "grill-me",
    reason:
      "Clarify genuine unresolved user-owned decisions one question at a time.",
    policy: "auto-install",
  },
  {
    label: "grill-with-docs",
    reason:
      "Clarify domain language, glossary terms, CONTEXT.md, and ADR-worthy decisions while grilling.",
    policy: "recommend-only",
  },
  {
    label: "brainstorming",
    reason:
      "Useful when Ged is designing or decomposing task slices before implementation.",
    policy: "recommend-only",
  },
  {
    label: "agent-browser",
    files: ["playwright.config.ts", "cypress.config.ts"],
    reason: "Useful when the project needs browser automation or UI testing.",
    policy: "recommend-only",
  },
];

export const BUNDLED_FOUNDATION_SKILLS = new Set([
  "find-skills",
  "skill-creator",
  "grill-me",
]);
export const BUNDLED_GED_SKILLS = new Set([
  ...BUNDLED_FOUNDATION_SKILLS,
  "grill-with-docs",
  "brainstorming",
]);

export interface SkillInstallPlan {
  commands: string[];
  installed: SkillCandidate[];
  steps: Array<{
    command: string;
    args: string[];
    summary: string;
  }>;
}

export interface SkillTrigger {
  name: string;
  triggers: string[];
  content: string;
}

export interface AvailableSkill extends SkillTrigger {
  source: "bundled" | "user" | "project";
  directory: string;
}

interface ProjectSkillRecord {
  name: string;
  source: "bundled" | "user" | "created";
  sourcePath?: string;
  taskRefs: string[];
  installedAt: string;
  reason?: string;
  provenance?: "installed-copy" | "reusable-explicit" | "legacy-unverified";
  contentHash?: string;
}

interface ProjectSkillState {
  schemaVersion?: 2;
  managed: ProjectSkillRecord[];
}

const PROJECT_SKILLS_STATE = "SKILLS-STATE.json";

export function toSkillCandidate(signal: SkillSignal): SkillCandidate {
  return {
    name: signal.label,
    reason: signal.reason,
    confidence: signal.policy === "auto-install" ? "high" : "medium",
    policy: signal.policy ?? "recommend-only",
  };
}

export function buildSkillInstallPlan(
  candidates: SkillCandidate[],
): SkillInstallPlan {
  const installed = candidates.filter(
    (candidate) => candidate.policy === "auto-install",
  );
  const steps = installed
    .filter((candidate) => !BUNDLED_GED_SKILLS.has(candidate.name))
    .map((candidate) => ({
      command: "npx",
      args: [
        "skills",
        "add",
        "https://github.com/vercel-labs/skills",
        "--skill",
        candidate.name,
      ],
      summary: `Install ${candidate.name}`,
    }));
  const commands = steps.map((step) => [step.command, ...step.args].join(" "));
  return { commands, installed, steps };
}

function parseTriggers(description: string): string[] {
  const listMatch = description.match(/Triggers include\s+(.*)/iu);
  if (!listMatch) return [];
  const triggers: string[] = [];
  for (const match of listMatch[1].matchAll(/"([^"]+)"/gu)) {
    triggers.push(match[1]);
  }
  return triggers;
}

function packageSkillsDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "skills",
  );
}

function maybeUserSkillDirs(): string[] {
  const home = process.env.HOME;
  if (!home) {
    return [];
  }
  return [
    path.join(home, ".codex", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

export function projectSkillsDir(rootDir: string): string {
  return path.join(rootDir, ".agents", "skills");
}

function projectSkillStatePath(rootDir: string): string {
  return path.join(rootDir, ".ged", PROJECT_SKILLS_STATE);
}

async function readProjectSkillState(
  rootDir: string,
): Promise<ProjectSkillState> {
  let raw: string;
  try {
    raw = await readFile(projectSkillStatePath(rootDir), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { schemaVersion: 2, managed: [] };
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Ged project skill provenance state is malformed.");
  }
  const state = parsed as Partial<ProjectSkillState>;
  if (
    (state.schemaVersion !== undefined && state.schemaVersion !== 2) ||
    !Array.isArray(state.managed)
  ) {
    throw new Error("Ged project skill provenance state is unsupported.");
  }
  const provenanceValues = new Set([
    "installed-copy",
    "reusable-explicit",
    "legacy-unverified",
  ]);
  const sourceValues = new Set(["bundled", "user", "created"]);
  const managed = state.managed.map((record) => {
    const value = record as Partial<ProjectSkillRecord>;
    if (
      typeof value.name !== "string" ||
      !value.name ||
      typeof value.source !== "string" ||
      !sourceValues.has(value.source) ||
      !Array.isArray(value.taskRefs) ||
      !value.taskRefs.every((taskRef) => typeof taskRef === "string") ||
      typeof value.installedAt !== "string" ||
      Number.isNaN(Date.parse(value.installedAt)) ||
      (value.provenance !== undefined &&
        !provenanceValues.has(value.provenance)) ||
      (value.reason !== undefined &&
        (typeof value.reason !== "string" || !value.reason.trim())) ||
      (value.contentHash !== undefined &&
        !/^[a-f0-9]{64}$/u.test(value.contentHash))
    ) {
      throw new Error("Ged project skill provenance record is invalid.");
    }
    return {
      ...(value as ProjectSkillRecord),
      provenance: value.provenance ?? "legacy-unverified",
    };
  });
  return { schemaVersion: 2, managed };
}

async function writeProjectSkillState(
  rootDir: string,
  state: ProjectSkillState,
): Promise<void> {
  await mkdir(path.join(rootDir, ".ged"), { recursive: true });
  await writeFileAtomic(
    projectSkillStatePath(rootDir),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function loadSkillTriggers(
  skillsDir: string,
): Promise<SkillTrigger[]> {
  const triggers = await loadAvailableSkillsFromDir(skillsDir, "bundled");
  return triggers.map(({ name, triggers: triggerList, content }) => ({
    name,
    triggers: triggerList,
    content,
  }));
}

async function loadAvailableSkillsFromDir(
  skillsDir: string,
  source: AvailableSkill["source"],
): Promise<AvailableSkill[]> {
  const skills: AvailableSkill[] = [];
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const directory = path.join(skillsDir, entry.name);
        const content = await readFile(
          path.join(directory, "SKILL.md"),
          "utf8",
        );
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/u);
        if (!frontmatterMatch) continue;
        const descMatch = frontmatterMatch[1].match(/description:\s*(.*)/u);
        if (!descMatch) continue;
        const triggerList = parseTriggers(descMatch[1]);
        skills.push({
          name: entry.name,
          triggers: triggerList,
          content,
          source,
          directory,
        });
      } catch {
        // skip unreadable skills
      }
    }
  } catch {
    // skills dir missing is fine
  }
  return skills;
}

export async function loadAvailableSkills(
  rootDir: string,
): Promise<AvailableSkill[]> {
  const [projectSkills, ...otherSources] = await Promise.all([
    loadAvailableSkillsFromDir(projectSkillsDir(rootDir), "project"),
    loadAvailableSkillsFromDir(packageSkillsDir(), "bundled"),
    ...maybeUserSkillDirs().map((dir) =>
      loadAvailableSkillsFromDir(dir, "user"),
    ),
  ]);
  const state = await readProjectSkillState(rootDir);
  const managed = new Map(state.managed.map((record) => [record.name, record]));
  const verifiedProjectSkills = projectSkills.filter((skill) => {
    const record = managed.get(skill.name);
    return (
      record?.provenance === "reusable-explicit" &&
      typeof record.contentHash === "string" &&
      record.contentHash === hashSkillContent(skill.content)
    );
  });

  const merged = new Map<string, AvailableSkill>();
  for (const skill of [verifiedProjectSkills, ...otherSources].flat()) {
    if (!merged.has(skill.name)) {
      merged.set(skill.name, skill);
    }
  }
  return [...merged.values()];
}

export function matchSkillsForTask(
  task: TaskBrief,
  skills: Pick<AvailableSkill, "name" | "triggers" | "content">[],
): Pick<AvailableSkill, "name" | "triggers" | "content">[] {
  const taskText = [
    task.id,
    task.title,
    task.objective,
    ...task.doneCriteria,
    ...task.skills,
  ]
    .join(" ")
    .toLowerCase();
  return skills.filter((skill) =>
    skill.triggers.some((trigger) => taskText.includes(trigger.toLowerCase())),
  );
}

const VALID_PROJECT_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

function hashSkillContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateReusableSkill(name: string, content: string): void {
  if (!VALID_PROJECT_SKILL_NAME.test(name) || name.includes("--")) {
    throw new Error(
      "Project skill names must use 1-64 lowercase letters, numbers, and single hyphens.",
    );
  }
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  if (
    !frontmatter ||
    !new RegExp(`^name:\\s*['"]?${name}['"]?\\s*$`, "mu").test(frontmatter) ||
    !/^description:\s*\S.+$/mu.test(frontmatter)
  ) {
    throw new Error(
      "Reusable project skills require matching name and non-empty description frontmatter.",
    );
  }
}

export async function createReusableProjectSkill(
  rootDir: string,
  name: string,
  content: string,
  provenance: { reason: string; source?: string },
): Promise<{ created: boolean; path: string }> {
  validateReusableSkill(name, content);
  if (!provenance.reason.trim()) {
    throw new Error("Reusable project skill provenance requires a reason.");
  }
  const skillPath = path.join(projectSkillsDir(rootDir), name, "SKILL.md");
  await Promise.all([
    assertSafeRepositoryWritePath(rootDir, skillPath),
    assertSafeRepositoryWritePath(rootDir, projectSkillStatePath(rootDir)),
  ]);
  const state = await readProjectSkillState(rootDir);
  let existing: string | null = null;
  try {
    existing = await readFile(skillPath, "utf8");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
  }
  if (existing !== null && existing !== content) {
    throw new Error(
      `Project skill ${name} already exists with different content; refusing to overwrite it.`,
    );
  }

  const record: ProjectSkillRecord = {
    name,
    source: "created",
    sourcePath: provenance.source,
    taskRefs: [],
    installedAt: new Date().toISOString(),
    reason: provenance.reason.trim(),
    provenance: "reusable-explicit",
    contentHash: hashSkillContent(content),
  };
  state.managed = [
    ...state.managed.filter((entry) => entry.name !== name),
    record,
  ];
  await writeProjectSkillState(rootDir, state);
  const created =
    existing === null ? await publishFileExclusive(skillPath, content) : false;
  if (!created && existing === null) {
    const concurrentlyCreated = await readFile(skillPath, "utf8");
    if (concurrentlyCreated !== content) {
      throw new Error(
        `Project skill ${name} was concurrently created with different content; provenance remains fail-closed until reconciled.`,
      );
    }
  }
  return { created, path: skillPath };
}

export async function ensureTaskSkillDependencies(
  rootDir: string,
  task: TaskBrief,
): Promise<{
  task: TaskBrief;
  installed: string[];
  created: string[];
}> {
  const available = await loadAvailableSkills(rootDir);
  const matched = matchSkillsForTask(task, available);

  const desired = new Set<string>([
    ...task.skills,
    ...matched.map((skill) => skill.name),
  ]);
  const installed: string[] = [];
  const created: string[] = [];
  // Matching affects only this task's declared context. Available bundled,
  // user, and trusted project skills are already discoverable by Pi. Missing
  // names remain visible so the coordinator can explicitly search or approve a
  // reusable skill; task prose is never turned into a skill automatically.
  return {
    task: {
      ...task,
      skills: [...new Set([...task.skills, ...desired])],
    },
    installed: [...new Set(installed)],
    created: [...new Set(created)],
  };
}

export async function cleanupUnusedProjectSkills(
  rootDir: string,
  activeTasks: TaskBrief[],
): Promise<string[]> {
  void rootDir;
  void activeTasks;
  // Reusable knowledge outlives the task that first needed it. Legacy records
  // without a verified generated-content hash are also retained rather than
  // risking deletion of user edits.
  return [];
}
