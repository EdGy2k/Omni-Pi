---
name: grill-me
description: Use before opening mutating work when the request has a genuine unresolved user-owned decision. Clarifies goals, desired behavior, constraints, edge cases, non-goals, tests, rollout, and success criteria one concise question at a time.
---

# grill-me

Use this skill **only when the request is not already fully clear**. If the
request is concrete enough to proceed safely, summarize it naturally and move
to skill-fit. Do not emit a required visible declaration.

## Goal

Make sure the agent and user share the same understanding before planning or implementation.

## Rules

- Ask exactly one unresolved question per turn in chat.
- Include `Recommended answer:` or `Default assumption:` when you have a sensible default.
- If a question can be answered by reading the codebase or durable `.ged/` memory, inspect those sources instead of asking.
- Walk the decision tree in dependency order: goal, users, current behavior, desired behavior, constraints, edge cases, non-goals, tests, rollout, success criteria.
- Stop as soon as behavior, constraints, and success criteria are concrete enough to update active work `SPEC.md`, `TASKS.md`, and `TESTS.md` safely.
- Do not implement during grilling.

## After grilling

Proceed to skill-fit resolution:

1. Inventory available bundled, project, and user skills.
2. Select relevant skills if coverage is sufficient.
3. Use `find-skills` if coverage is insufficient.
4. Use `skill-creator` to create a narrow project-local skill when no adequate external skill exists and the gap is reusable.
