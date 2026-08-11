---
name: find-skills
description: "Discover external skills during GedPi skill-fit when bundled, trusted project, and user skills do not cover a real capability gap. Triggers include \"find a skill\", \"skill for\", \"need a skill\", \"search skills\", \"skill-fit\""
---

# Find Skills

Inventory before searching:

- bundled package skills;
- trusted project `.agents/skills/`;
- user `~/.agents/skills/` and Pi skill locations.

Search only for a concrete missing capability, usually with
`npx skills find <narrow query>`. Review the candidate SKILL content and source;
install counts alone are not evidence of fit or safety.

## Decision path

1. If an existing skill fits, use it without copying it.
2. If an external skill is reusable and the user/coordinator approves project
   scope, pass reviewed content and provenance through `ged_skill` so it lands
   in Pi-native `.agents/skills/`.
3. Install globally only with explicit user intent.
4. If nothing fits and the gap is reusable/project-specific, use
   `skill-creator`.
5. If it is one-off, continue without a skill.

Never auto-generate a skill from task prose, silently shadow an existing skill,
or delete a project skill when a task closes. Read-only scouts may report
candidates but cannot install or create them.
