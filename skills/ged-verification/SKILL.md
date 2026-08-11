---
name: ged-verification
description: Runs checks from .ged/work/<work-id>/TESTS.md after task implementation, summarizes pass/fail, and prepares retry briefs. Triggers include "verify", "test", "check", "did it work", or after completing an implementation task.
---

# Ged Verification

## Goals

- run the planned checks from `.ged/work/<work-id>/TESTS.md`
- summarize pass/fail status clearly
- produce a compact retry brief when checks fail

## Rules

- keep verification deterministic when possible
- separate implementation failure from environment failure
- make the next action obvious


## Ged skill-fit workflow

For planned-change work, planning follows any genuinely needed clarification and skill-fit resolution. Optional assistants may inventory or evaluate skills, but the coordinator decides and performs project-scoped installs/creation. Staffing does not change governance, and global/user skills are never installed automatically.
