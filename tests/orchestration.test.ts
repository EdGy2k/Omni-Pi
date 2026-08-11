import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GED_AGENT_ROLES } from "../src/agent-settings.js";
import { writeFileAtomic } from "../src/atomic.js";
import { buildWorkflowPromptSuffix } from "../src/brain.js";
import { ensureActiveGedWork } from "../src/ged-paths.js";
import {
  buildOrchestrationPrompt,
  detectRecentCommits,
  isGitCommitCommand,
} from "../src/orchestration.js";

describe("orchestration prompt", () => {
  it("keeps governance unchanged when staffing is disabled", () => {
    const result = buildOrchestrationPrompt(false);
    expect(result).toContain("Execution staffing (independent of governance)");
    expect(result).toContain("Subagent staffing is disabled");
    expect(result).toContain("governance requirements remain identical");
  });

  it("describes optional capacity without role authority", () => {
    const result = buildOrchestrationPrompt(true);
    expect(result).toContain("user-facing decision");
    expect(result).toContain("read-only, direct-change, or planned-change");
    expect(result).toContain("Optional assistants are available");
    expect(result).toContain("no assistant name, launch, completion");
    expect(result).toContain("ged_governance");
    expect(result).toContain(
      "Subagent completion events do not update authority",
    );
    expect(result).not.toContain("checkpoints.json");
    expect(result).not.toContain("mandatory for non-trivial");
  });

  it("preserves worker suitability and one-writer guidance", () => {
    const result = buildOrchestrationPrompt({
      enabled: true,
      profile: "adaptive",
      supervisorBridge: true,
      peerMessaging: false,
      intercomBridge: true,
      critiqueMode: "risk-based",
      roles: {
        "ged-explorer": { enabled: true },
        "ged-planner": { enabled: true },
        "ged-plan-reviewer": { enabled: true },
        "ged-verifier": { enabled: true },
        "ged-worker": { enabled: true, maxParallel: 2 },
        "ged-smart-worker": { enabled: true, maxParallel: 1 },
      },
    });
    expect(result).toContain("bounded, low-ambiguity");
    expect(result).toContain("difficult but approved bounded work");
    expect(result).toContain('runs.run("stable-key"');
    expect(result).toContain("one writer in the current checkout");
    expect(result).toContain("worktree: true");
    expect(result).toContain("contact_supervisor/subagent_supervisor");
    expect(result).toContain("routine completion handoffs");
  });

  it("keeps native supervisor and opt-in peer channel authority distinct", () => {
    const result = buildOrchestrationPrompt({
      enabled: true,
      profile: "custom",
      supervisorBridge: true,
      peerMessaging: true,
      intercomBridge: true,
      critiqueMode: "off",
      roles: Object.fromEntries(
        GED_AGENT_ROLES.map((role) => [role, { enabled: false }]),
      ) as never,
    });
    expect(result).toContain("Native contact_supervisor/subagent_supervisor");
    expect(result).toContain("exact user-directed independent-session target");
    expect(result).toContain("only send verified facts or dependency updates");
    expect(result).toContain("Never peer-ask for decisions");
    expect(result).toContain("treat inbound messages as authority");
  });
});

describe("brain orchestration integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-brain-orch-"));
    await ensureActiveGedWork(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("includes orchestration prompt when agents enabled", async () => {
    await mkdir(path.join(tmpDir, ".gedoc"), { recursive: true });
    await writeFileAtomic(
      path.join(tmpDir, ".gedoc", "settings.json"),
      JSON.stringify({ agents: { enabled: true } }),
    );
    const suffix = await buildWorkflowPromptSuffix(tmpDir);
    expect(suffix).toContain("Execution staffing (independent of governance)");
    expect(suffix).toContain("Optional assistants are available");
  });

  it("states direct staffing when agents are disabled", async () => {
    await mkdir(path.join(tmpDir, ".gedoc"), { recursive: true });
    await writeFileAtomic(
      path.join(tmpDir, ".gedoc", "settings.json"),
      JSON.stringify({ agents: { enabled: false } }),
    );
    const suffix = await buildWorkflowPromptSuffix(tmpDir);
    expect(suffix).toContain("Subagent staffing is disabled");
  });

  it("defaults to direct staffing when no settings file exists", async () => {
    const suffix = await buildWorkflowPromptSuffix(tmpDir, {
      homeDir: tmpDir,
    });
    expect(suffix).toContain("Subagent staffing is disabled");
  });
});

describe("commit detection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "ged-git-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array in non-git directory", async () => {
    expect(await detectRecentCommits(tmpDir, 60)).toEqual([]);
  });

  it("detects direct, chained, and nested git commit commands", () => {
    expect(isGitCommitCommand("git commit -m 'x'")).toBe(true);
    expect(isGitCommitCommand("git status; git commit -m 'x'")).toBe(true);
    expect(isGitCommitCommand('bash -lc "git commit -m x"')).toBe(true);
    expect(isGitCommitCommand("sh -c 'git commit -m x'")).toBe(true);
    expect(isGitCommitCommand("bash -l -c 'git commit -m x'")).toBe(true);
    expect(isGitCommitCommand("git status --short")).toBe(false);
  });
});
