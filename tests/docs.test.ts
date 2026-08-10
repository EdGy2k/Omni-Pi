import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

describe("documentation coverage", () => {
  test("README documents bundled commands", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );

    expect(readme).toContain(
      "| `/diff-review` | Open a native git diff review window and insert feedback into the editor |",
    );
    expect(readme).toContain(
      "| `/commit` | Review local changes and create a descriptive conventional commit |",
    );
    expect(readme).toContain(
      "| `/push` | Push the current branch, with automatic recovery flow if the first push fails |",
    );
    expect(readme).toContain("| `/grill-me` |");
  });

  test("README and backlog document the repo-map feature and deferred roadmap", () => {
    const readme = readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8",
    );
    const backlog = readFileSync(
      new URL("../docs/BACKLOG.md", import.meta.url),
      "utf8",
    );

    expect(readme).toContain("### Repo Map");
    expect(readme).toContain("`.pi/repo-map/`");
    expect(readme).toContain("semantic symbol summaries");
    expect(readme).toContain("git co-change ranking");
    expect(backlog).toContain("## Repo Map roadmap");
    expect(backlog).toContain("Shipped core:");
    expect(backlog).toContain("Deferred follow-up work:");
    expect(backlog).toContain("dead-code / unused-export analysis");
  });

  test("orchestration docs cover acceptance contracts and deferred parallel exploration roadmap", () => {
    const orchestration = readFileSync(
      new URL(
        "../docs/single-writer-intelligence-orchestration.md",
        import.meta.url,
      ),
      "utf8",
    );
    const backlog = readFileSync(
      new URL("../docs/BACKLOG.md", import.meta.url),
      "utf8",
    );

    expect(orchestration).toContain("## Worker acceptance contracts");
    expect(orchestration).toContain("criteria");
    expect(orchestration).toContain("evidence");
    expect(orchestration).toContain("verify");
    expect(orchestration).toContain("stopRules");
    expect(orchestration).not.toContain("maxFinalizationTurns");
    expect(orchestration).toContain("workflowScript");
    expect(orchestration).toContain("turnBudget");
    expect(orchestration).toContain(
      "Structured verifier and checkpoint evidence",
    );
    expect(orchestration).toContain("Structured planner and explorer outputs");
    expect(orchestration).toContain(
      "Parallel explorer agents and dynamic fanout",
    );
    expect(orchestration).toContain("Prompt-context dedupe");
    expect(backlog).toContain("parallel `ged-explorer` agents");
    expect(backlog).toContain("ctx.getSystemPromptOptions()");
  });
});
