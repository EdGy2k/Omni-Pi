import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { createReusableProjectSkill } from "./skills.js";

export function registerReusableSkillTool(api: ExtensionAPI): void {
  api.registerTool({
    name: "ged_skill",
    label: "Ged reusable project skill",
    description:
      "Create one explicitly approved reusable project skill in Pi's native .agents/skills project directory with durable Ged provenance. Never use for one-off task prose.",
    promptSnippet: "Create reusable project skill with provenance",
    promptGuidelines: [
      "Use only after skill-fit found a real reusable, project-specific capability gap.",
      "Do not create a skill merely because a task has no matching skill.",
      "The main coordinator owns this decision; assistants may only recommend it.",
    ],
    parameters: Type.Object(
      {
        name: Type.String({
          minLength: 1,
          maxLength: 64,
          pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
        }),
        content: Type.String({ minLength: 1, maxLength: 100_000 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
        source: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await createReusableProjectSkill(
        ctx.cwd,
        params.name,
        params.content,
        { reason: params.reason, source: params.source },
      );
      return {
        content: [
          {
            type: "text",
            text: `${result.created ? "Created" : "Confirmed"} reusable project skill ${params.name} at ${result.path}. It persists independently of any task lifecycle.`,
          },
        ],
        details: result,
      };
    },
  });
}
