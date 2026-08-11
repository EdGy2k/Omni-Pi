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

  test("orchestration docs cover governance and deferred adaptive staffing", () => {
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

    expect(orchestration).toContain("## Governance plane");
    expect(orchestration).toContain("### Role-neutral transitions");
    expect(orchestration).toContain("sole machine authority");
    expect(orchestration).toContain("later in append order");
    expect(orchestration).toContain("## Current enforcement boundary");
    expect(orchestration).toContain("Plan 002");
    expect(orchestration).toContain("## Execution staffing plane");
    expect(orchestration).toContain("One writer");
    expect(orchestration).toContain("pi-intercom");
    expect(backlog).toContain("parallel `ged-explorer` agents");
    expect(backlog).toContain("ctx.getSystemPromptOptions()");
  });
});
