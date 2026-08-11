import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { syncGedSubagentRuntimeConfig } from "../../src/agent-settings.js";
import {
  buildPassiveGedPromptSuffix,
  buildWorkflowPromptSuffix,
  ensureGedReady,
  renderPromptContentBlock,
} from "../../src/brain.js";
import { createGedCommands } from "../../src/commands.js";
import { renderHeader } from "../../src/header.js";
import { registerDurableMemoryTool } from "../../src/memory-runtime.js";
import {
  registerGedMessageRenderer,
  registerPiCommands,
} from "../../src/pi.js";
import { registerPlanReviewTool } from "../../src/plan-review.js";
import { ensureBundledPromptTemplates } from "../../src/prompt-template-sync.js";
import {
  buildRepoMapPromptSuffix,
  registerRepoMapTracking,
  warmRepoMap,
} from "../../src/repo-map-runtime.js";
import {
  refreshRtkStatusIndicator,
  registerRtkBashRouting,
} from "../../src/rtk.js";
import { registerReusableSkillTool } from "../../src/skill-runtime.js";
import { ensurePiSettings, formatGedStatus } from "../../src/theme.js";
import { registerUpdater } from "../../src/updater.js";
import { registerGedWorkRuntime } from "../../src/work-runtime.js";
import { buildOnboardingInterviewKickoff } from "../../src/workflow.js";
import { registerGhostlightUi } from "./ghostlight-ui.js";

export default async function gedCoreExtension(
  api: ExtensionAPI,
): Promise<void> {
  // Task identity and governance are runtime-owned and independent of optional
  // staffing. Subagent completion events intentionally carry no authority.
  registerGedWorkRuntime(api);

  registerGedMessageRenderer(api);
  registerPiCommands(api, createGedCommands());
  registerUpdater(api);
  registerRtkBashRouting(api);
  registerRepoMapTracking(api);
  registerPlanReviewTool(api);
  registerDurableMemoryTool(api);
  registerReusableSkillTool(api);
  registerGhostlightUi(api);

  api.on("session_start", async (_event, ctx) => {
    await ensurePiSettings(ctx.cwd);
    const staffingSync = await syncGedSubagentRuntimeConfig(
      ctx.cwd,
      ctx.modelRegistry
        ? {
            modelAvailability: {
              isAvailable(modelId) {
                const slashIndex = modelId.indexOf("/");
                if (slashIndex <= 0 || slashIndex === modelId.length - 1) {
                  return false;
                }
                const provider = modelId.slice(0, slashIndex);
                const id = modelId.slice(slashIndex + 1);
                return Boolean(ctx.modelRegistry.find(provider, id));
              },
            },
          }
        : undefined,
    );
    if (staffingSync.diagnostics.length > 0 && ctx.hasUI) {
      ctx.ui.notify(staffingSync.diagnostics.join("\n"), "warning");
    }
    ensureBundledPromptTemplates(
      fileURLToPath(
        new URL("../../templates/managed-prompts", import.meta.url),
      ),
    );
    if (ctx.mode === "tui") {
      ctx.ui.setTitle("GedPi");
      ctx.ui.setHeader((_tui, theme) => renderHeader(theme));
      ctx.ui.setStatus("gedpi", formatGedStatus());
      await refreshRtkStatusIndicator(ctx);
    }
    void warmRepoMap(ctx.cwd);
  });

  api.on("before_agent_start", async (event, ctx) => {
    const init = await ensureGedReady(ctx.cwd, {
      ui: "ui" in ctx ? ctx.ui : undefined,
    });
    const [passivePrompt, repoMapPrompt, workflowPrompt] = await Promise.all([
      buildPassiveGedPromptSuffix(ctx.cwd),
      buildRepoMapPromptSuffix(ctx.cwd, {
        prompt: typeof event.prompt === "string" ? event.prompt : "",
      }),
      buildWorkflowPromptSuffix(ctx.cwd),
    ]);
    const framedRepoMapPrompt = repoMapPrompt
      ? `## Current Repository Map Data\n\n${renderPromptContentBlock(
          "runtime-data",
          "repository-map",
          repoMapPrompt,
          Number.MAX_SAFE_INTEGER,
        )}`
      : "";

    const onboardingKickoff = init.initResult?.onboardingInterviewNeeded
      ? buildOnboardingInterviewKickoff(init.initResult)
      : "";
    const prompt = [
      event.systemPrompt,
      passivePrompt,
      workflowPrompt,
      framedRepoMapPrompt,
      onboardingKickoff,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (init.initResult?.standardsPromptNeeded) {
      api.sendMessage({
        customType: "ged-update",
        content:
          "Ged found external instruction files that can be imported into .ged/STANDARDS.md. Please confirm in chat whether Ged should keep those standards.",
        display: true,
        details: { title: "ged-init" },
      });
    }

    return { systemPrompt: prompt };
  });
}
