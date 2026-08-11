---
name: ged-init
description: Initializes or migrates GedPi machine metadata and captures substantive project context lazily. Use for initialize, setup, new project, configure, or missing .ged metadata.
---

# Ged Init

## Goals

- initialize only required `.ged` machine metadata and an immutable bootstrap
  work identity;
- inspect repository stack/tooling and determine whether onboarding facts are
  sufficiently clear;
- create `.ged/PROJECT.md` only after real goal/user/constraint/success facts
  exist;
- discover external instructions and import only explicitly approved,
  content-hash-bound bytes;
- migrate legacy content non-destructively and report retained ambiguous data.

Do not create placeholder project, planning, progress, status, handoff, or skill
files. Root `CONTEXT.md`, `docs/adr/`, work artifacts, reports, and projections
are lazy. `governance.json`, not Markdown, owns runtime authority.

## Outputs

- required schema/import/selection/work-identity metadata;
- optional substantive `.ged/PROJECT.md` after onboarding;
- migration result and any standards approval request.
