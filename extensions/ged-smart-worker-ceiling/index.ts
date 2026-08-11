import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const SMART_WORKER_READ_ONLY_AGENTS = [
  "ged-explorer",
  "ged-planner",
  "ged-plan-reviewer",
  "ged-verifier",
] as const;

const SMART_WORKER_CHILD_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "contact_supervisor",
  "structured_output",
] as const;

interface CapabilityCeilingHandle {
  dispose(): void;
}

export default async function gedSmartWorkerCeiling(
  api: ExtensionAPI,
): Promise<void> {
  const moduleId = "pi-subagents/capability-ceiling";
  const capabilityApi = await createJiti(import.meta.url).import<{
    registerSubagentCapabilityCeiling(options: {
      sessionId: string;
      source: string;
      ceiling: {
        allowedAgents: readonly string[];
        allowedTools: readonly string[];
      };
    }): CapabilityCeilingHandle;
  }>(moduleId);
  let handle: CapabilityCeilingHandle | undefined;

  api.on("session_start", (_event, ctx) => {
    handle?.dispose();
    handle = capabilityApi.registerSubagentCapabilityCeiling({
      sessionId: ctx.sessionManager.getSessionId(),
      source: "ged-smart-worker-read-only-fanout",
      ceiling: {
        allowedAgents: SMART_WORKER_READ_ONLY_AGENTS,
        allowedTools: SMART_WORKER_CHILD_TOOLS,
      },
    });
  });

  api.on("session_shutdown", () => {
    handle?.dispose();
    handle = undefined;
  });
}
