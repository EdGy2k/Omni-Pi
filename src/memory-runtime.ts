import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { GED_DIR } from "./contracts.js";
import {
  createAdr,
  createHandoffProjection,
  createProjectSummary,
  createReadOnlyReport,
  createRootContext,
} from "./durable-memory.js";
import { gedPathsForWorkId } from "./ged-paths.js";

export function registerDurableMemoryTool(api: ExtensionAPI): void {
  api.registerTool({
    name: "ged_memory",
    label: "Ged durable memory",
    description:
      "Create one substantive lazy Ged memory artifact. Empty or placeholder content is rejected; governance still owns mutation authority.",
    promptSnippet: "Create substantive durable memory only when warranted",
    promptGuidelines: [
      "Use PROJECT for current product context, CONTEXT for domain vocabulary, and ADR only for durable trade-off decisions.",
      "Use report for a substantive read-only result and handoff only for a real cross-session handoff.",
      "Never use Markdown as workflow authorization; governance.json remains authoritative.",
    ],
    parameters: Type.Object(
      {
        operation: Type.Union([
          Type.Literal("project-summary"),
          Type.Literal("report"),
          Type.Literal("context"),
          Type.Literal("adr"),
          Type.Literal("handoff"),
        ]),
        content: Type.String({ minLength: 1, maxLength: 200_000 }),
        id: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 128,
            pattern: "^[a-z0-9][a-z0-9._-]{0,127}$",
          }),
        ),
        workId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let created: boolean;
      let artifactPath: string;
      switch (params.operation) {
        case "project-summary":
          created = await createProjectSummary(ctx.cwd, params.content);
          artifactPath = path.join(ctx.cwd, GED_DIR, "PROJECT.md");
          break;
        case "report":
          if (!params.id) throw new Error("ged_memory report requires id.");
          created = await createReadOnlyReport(
            ctx.cwd,
            params.id,
            params.content,
          );
          artifactPath = path.join(
            ctx.cwd,
            GED_DIR,
            "reports",
            `${params.id}.md`,
          );
          break;
        case "context":
          created = await createRootContext(ctx.cwd, params.content);
          artifactPath = path.join(ctx.cwd, "CONTEXT.md");
          break;
        case "adr":
          if (!params.id) throw new Error("ged_memory adr requires id.");
          created = await createAdr(ctx.cwd, params.id, params.content);
          artifactPath = path.join(ctx.cwd, "docs", "adr", `${params.id}.md`);
          break;
        case "handoff":
          if (!params.workId) {
            throw new Error("ged_memory handoff requires workId.");
          }
          created = await createHandoffProjection(
            ctx.cwd,
            params.workId,
            params.content,
          );
          artifactPath = gedPathsForWorkId(
            ctx.cwd,
            params.workId,
          ).sessionSummaryPath;
          break;
      }
      if (!created) {
        throw new Error(
          `ged_memory ${params.operation} requires substantive content and refuses to overwrite an existing artifact.`,
        );
      }
      return {
        content: [
          {
            type: "text",
            text: `Created ${params.operation} at ${artifactPath}.`,
          },
        ],
        details: { created, operation: params.operation, path: artifactPath },
      };
    },
  });
}
