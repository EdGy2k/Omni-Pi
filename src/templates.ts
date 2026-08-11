import { GED_DIR } from "./contracts.js";

export interface StarterFile {
  path: string;
  content: string;
}

export const DEFAULT_WORK_SPEC = `# Spec

## Problem

## Solution shape

## Key workflows

## Risks

## Open questions
`;

export const DEFAULT_WORK_TASKS = `# Tasks

## Task slices

| ID | Title | Depends On | Status | Done Criteria |
| --- | --- | --- | --- | --- |
`;

export const DEFAULT_WORK_TESTS = `# Tests

## Project-wide checks

-

## Task-specific checks

-

## Retry policy

- Implementation retries before the plan must be tightened: 2

## Recovery rule

- If the same slice fails repeatedly, rewrite the slice, clarify the spec, and retry with a narrower plan.
`;

export const DEFAULT_WORK_NOTES = `# Notes

`;

// Fresh initialization persists machine metadata only. Human-readable project,
// work, skill, report, and handoff artifacts are created by explicit
// create-on-substance helpers when they have real content.
export const starterFiles: StarterFile[] = [
  {
    path: `${GED_DIR}/VERSION`,
    content: `3
`,
  },
  {
    path: `${GED_DIR}/.gitignore`,
    content: `# Ephemeral session state
runtime/

# Local repo-map cache artifacts
REPO-MAP.md
REPO-MAP.json
`,
  },
];
