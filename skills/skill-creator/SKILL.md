---
name: skill-creator
description: "Create an explicit reusable project skill after skill-fit finds no adequate existing skill and the gap is project-specific, non-obvious, and likely to recur. Triggers include \"create a skill\", \"project skill\", \"capture reusable workflow\", \"custom skill\""
---

# Skill Creator

Use only after `find-skills` finds no adequate capability and the coordinator
decides the gap is reusable project knowledge. A task brief is not a skill.

## Worth creating

- the procedure or domain knowledge will help multiple future tasks;
- it is specific to this repository/team;
- a capable model would not reliably infer it from source and ordinary docs.

Skip one-off work, common knowledge, tiny task instructions, and hypothetical
future needs. Continue without a skill when the gap is not reusable.

## Contract

1. Write concise Agent Skills-compatible content with matching lowercase
   hyphenated `name` and a specific `description`.
2. Call `ged_skill` with the final content, reusable-gap reason, and source or
   provenance. Do not write legacy `.ged/project-skills/` paths directly.
3. GedPi creates `.agents/skills/<name>/SKILL.md`, which Pi discovers natively in
   trusted projects, plus lazy hash/provenance metadata.
4. Never overwrite a different existing skill. Refine explicitly instead.
5. Reusable skills persist when the motivating task completes; GedPi never
   auto-deletes them.

Assistants may recommend a skill but never authorize or create it. The main
coordinator owns the decision and governed mutation.
