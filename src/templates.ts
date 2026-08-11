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

export const starterFiles: StarterFile[] = [
  {
    path: `${GED_DIR}/VERSION`,
    content: `2
`,
  },
  {
    path: `${GED_DIR}/CONTEXT-MAP.md`,
    content: `# Context Map

Ged memory is current-state oriented. Durable root files describe the project as it is now; active work and runtime state are scoped by immutable work-item IDs rather than branches.

## Durable root memory

- \`.ged/PROJECT.md\` — product goal, users, constraints, success criteria, repo signals.
- \`.ged/ARCHITECTURE.md\` — current component boundaries and system shape.
- \`.ged/PATTERNS.md\` — conventions and implementation patterns.
- \`.ged/GLOSSARY.md\` — project/domain vocabulary.
- \`.ged/DECISIONS.md\` — durable decisions and rationale.
- \`.ged/STANDARDS.md\` — imported repo-wide agent standards.
- \`.ged/SKILLS.md\` — durable skill guidance.

## Active work memory

- \`.ged/work/<work-id>/SPEC.md\`
- \`.ged/work/<work-id>/TASKS.md\`
- \`.ged/work/<work-id>/TESTS.md\`
- \`.ged/work/<work-id>/NOTES.md\`
- \`.ged/work/<work-id>/META.json\`

## Runtime memory

- \`.ged/runtime/active-work/<session-key>.json\` (ignored session selection)
- \`.ged/runtime/<work-id>/governance.json\` (authoritative structured state)
- \`.ged/runtime/<work-id>/STATE.md\`
- \`.ged/runtime/<work-id>/SESSION-SUMMARY.md\`
`,
  },
  {
    path: `${GED_DIR}/PROJECT.md`,
    content: `# Project

## Goal

Describe what this project should achieve.

## Users

- Primary users:
- Secondary users:

## Constraints

- Technical constraints:
- Product constraints:

## Success Criteria

- What does success look like?
`,
  },
  {
    path: `${GED_DIR}/ARCHITECTURE.md`,
    content: `# Architecture

Describe current system components, boundaries, and data flow.
`,
  },
  {
    path: `${GED_DIR}/PATTERNS.md`,
    content: `# Patterns

Record implementation conventions and recurring workflow patterns.
`,
  },
  {
    path: `${GED_DIR}/GLOSSARY.md`,
    content: `# Glossary

Record domain terms and definitions.
`,
  },
  {
    path: `${GED_DIR}/IDEAS.md`,
    content: `# Ideas

## Active ideas

-

## Future ideas

-

## Parking lot

-
`,
  },
  {
    path: `${GED_DIR}/DECISIONS.md`,
    content: `# Decisions

Record important choices here as the project evolves.

## Entries

- Date: YYYY-MM-DD
  - Decision:
  - Why:
  - Impact:
`,
  },
  {
    path: `${GED_DIR}/STANDARDS.md`,
    content: `# Imported Standards

These standards were imported from other harness-specific instruction files and approved for Ged use.

No imported standards have been accepted yet.
`,
  },
  {
    path: `${GED_DIR}/SKILLS.md`,
    content: `# Skills

## Installed

- None yet

## Recommended

- None yet

## Deferred

- None yet

## Rejected

- None yet

## Usage Notes

- Record why a skill was installed, recommended, or skipped.
`,
  },
  {
    path: `${GED_DIR}/project-skills/README.md`,
    content: `# Project Skills

Store project-scoped skills that Ged auto-installs or creates for active tasks here.
`,
  },
  {
    path: `${GED_DIR}/SKILLS-STATE.json`,
    content: `{
  "managed": []
}
`,
  },
  {
    path: `${GED_DIR}/PROGRESS.md`,
    content: `# Progress

Ongoing log of project progress.

`,
  },
  {
    path: `${GED_DIR}/plans/INDEX.md`,
    content: `# Plan Index

| ID | Title | Status | Created | Completed |
| --- | --- | --- | --- | --- |
`,
  },
  {
    path: `${GED_DIR}/research/README.md`,
    content: `# Research

Store external research summaries and package notes here.
`,
  },
  {
    path: `${GED_DIR}/specs/README.md`,
    content: `# Specs

Store durable detailed specs here when they remain useful after active work completes.
`,
  },
  {
    path: `${GED_DIR}/tasks/README.md`,
    content: `# Task Artifacts

Store per-task briefs, outputs, and failure histories here when they should outlive runtime summaries.
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
  {
    path: `.pi/agents/ged-brain.md`,
    content: `---
name: ged-brain
description: GedPi brain for user-facing clarifying, planning, and implementation
model: anthropic/claude-opus-4-6
tools: read, grep, find, ls, bash
skill: ged-planning, ged-execution, ged-verification
---

You are GedPi's only user-facing agent.

Clarify with grill-me until the requested behavior, constraints, and success criteria are concrete enough to implement safely.
Write durable project context into .ged/PROJECT.md and active work context into .ged/work/<work-id>/SPEC.md.
Break the work into bounded slices in .ged/work/<work-id>/TASKS.md before editing code.
Run the planned checks, record outcomes in .ged/runtime/<work-id>/STATE.md and .ged/runtime/<work-id>/SESSION-SUMMARY.md, and tighten the plan if a slice fails.
`,
  },
];
