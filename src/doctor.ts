import { readFile } from "node:fs/promises";
import path from "node:path";

import { taskArtifactDir } from "./durable-memory.js";
import { activeGedPaths, readWorkItemMeta } from "./ged-paths.js";
import { detectRepoSignals } from "./repo.js";
import { GED_STANDARD_VERSION, readGedVersion } from "./standards.js";
import { readTasks } from "./tasks.js";

export type HealthLevel = "green" | "yellow" | "red";

export interface DiagnosticResult {
  name: string;
  level: HealthLevel;
  message: string;
}

export interface DoctorReport {
  overall: HealthLevel;
  checks: DiagnosticResult[];
}

async function checkGedInitialized(rootDir: string): Promise<DiagnosticResult> {
  try {
    const version = await readGedVersion(rootDir);
    const paths = await activeGedPaths(rootDir);
    await readWorkItemMeta(rootDir, paths.workId);
    if (version !== GED_STANDARD_VERSION) {
      return {
        name: "ged-init",
        level: "red",
        message: `Ged memory version ${version ?? "missing"} needs migration to ${GED_STANDARD_VERSION}.`,
      };
    }
  } catch {
    return {
      name: "ged-init",
      level: "red",
      message:
        "Ged version or bootstrap work identity not found. Run /ged-init to initialize the project.",
    };
  }
  return { name: "ged-init", level: "green", message: "GedPi initialized." };
}

async function checkRepoSignals(rootDir: string): Promise<DiagnosticResult> {
  const signals = await detectRepoSignals(rootDir);
  if (signals.languages.length === 0) {
    return {
      name: "repo-signals",
      level: "yellow",
      message:
        "No programming languages detected. Verification commands may not be inferred automatically.",
    };
  }
  return {
    name: "repo-signals",
    level: "green",
    message: `Detected: ${signals.languages.join(", ")}.`,
  };
}

async function checkOrphanedTasks(rootDir: string): Promise<DiagnosticResult> {
  try {
    const paths = await activeGedPaths(rootDir);
    const tasks = await readTasks(paths.tasksPath);
    const inProgress = tasks.filter((t) => t.status === "in_progress");
    const blocked = tasks.filter((t) => t.status === "blocked");

    if (blocked.length > 0) {
      return {
        name: "task-health",
        level: "red",
        message: `${blocked.length} blocked task(s): ${blocked.map((t) => t.id).join(", ")}. Review escalation notes or restructure the plan.`,
      };
    }
    if (inProgress.length > 1) {
      return {
        name: "task-health",
        level: "yellow",
        message: `${inProgress.length} tasks marked in_progress simultaneously. Only one should be active.`,
      };
    }
    return {
      name: "task-health",
      level: "green",
      message: "Tasks are healthy.",
    };
  } catch {
    return {
      name: "task-health",
      level: "green",
      message: "No tasks file yet.",
    };
  }
}

export interface StuckSignal {
  detected: boolean;
  reason: string;
  taskId?: string;
}

export async function detectStuck(rootDir: string): Promise<StuckSignal> {
  try {
    const paths = await activeGedPaths(rootDir);
    const tasks = await readTasks(paths.tasksPath);
    const inProgressOrTodo = tasks.filter(
      (t) => t.status === "in_progress" || t.status === "todo",
    );
    if (inProgressOrTodo.length === 0) {
      return { detected: false, reason: "No active tasks." };
    }

    const candidate = inProgressOrTodo[0];
    try {
      const historyPath = path.join(
        taskArtifactDir(rootDir, paths.workId, candidate.id),
        "HISTORY.json",
      );
      const raw = await readFile(historyPath, "utf8");
      const history = JSON.parse(raw) as Array<{
        verification: { passed: boolean; failureSummary: string[] };
      }>;
      const failures = history.filter((h) => !h.verification.passed);

      if (failures.length >= 3) {
        const lastErrors = failures
          .slice(-3)
          .map((f) => f.verification.failureSummary.join("; "));
        const allSame =
          lastErrors.length === 3 &&
          lastErrors[0] === lastErrors[1] &&
          lastErrors[1] === lastErrors[2];

        if (allSame) {
          return {
            detected: true,
            reason: `Task ${candidate.id} has failed 3+ times with the same error: "${lastErrors[0]}".`,
            taskId: candidate.id,
          };
        }

        return {
          detected: true,
          reason: `Task ${candidate.id} has ${failures.length} failures. Consider splitting or restructuring.`,
          taskId: candidate.id,
        };
      }
    } catch {
      // no history yet
    }

    return { detected: false, reason: "No stuck signals." };
  } catch {
    return { detected: false, reason: "Could not read tasks." };
  }
}

function worstLevel(checks: DiagnosticResult[]): HealthLevel {
  if (checks.some((c) => c.level === "red")) return "red";
  if (checks.some((c) => c.level === "yellow")) return "yellow";
  return "green";
}

export async function runDoctor(rootDir: string): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkGedInitialized(rootDir),
    checkRepoSignals(rootDir),
    checkOrphanedTasks(rootDir),
  ]);

  const stuck = await detectStuck(rootDir);
  if (stuck.detected) {
    checks.push({
      name: "stuck-detection",
      level: "red",
      message: stuck.reason,
    });
  }

  return { overall: worstLevel(checks), checks };
}

const HEALTH_ICONS: Record<HealthLevel, string> = {
  green: "[OK]",
  yellow: "[WARN]",
  red: "[FAIL]",
};

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`Health: ${HEALTH_ICONS[report.overall]} ${report.overall}`];
  for (const check of report.checks) {
    lines.push(
      `  ${HEALTH_ICONS[check.level]} ${check.name}: ${check.message}`,
    );
  }
  return lines.join("\n");
}
