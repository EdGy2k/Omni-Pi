# Durable memory artifact contract

GedPi persists an artifact only when it has one owner, a named consumer, a
defined authority level, and a lifecycle. `src/durable-memory.ts` exports the
same inventory for runtime/tests.

| Artifact | Producer | Consumer | Authority | Lifecycle |
| --- | --- | --- | --- | --- |
| `.ged/VERSION` | init/migration | init, doctor | machine | required, monotonic |
| `.ged/.gitignore` | init | Git | machine | required runtime-ignore rules |
| `.ged/IMPORT-STATE.json` | standards import | hash verification and renewed approval | machine | lazy import decisions |
| `.ged/MEMORY-MIGRATION.json` | v3 migration | startup convergence, humans | machine | immutable completion record |
| `.ged/runtime/migrations/durable-memory-v3/*` | v3 migration | migration recovery and byte verification | machine | ignored backups, journal, stale-lock evidence |
| `.ged/runtime/active-work/<session-key>.json` | work runtime | work selection, guards | machine | ignored, session-scoped |
| `.ged/runtime/<work-id>/governance.json` | governance store | all mutation/commit/lifecycle guards | sole machine authority | monotonic revisions/evidence |
| `.ged/work/<work-id>/META.json` | work runtime | governance identity, artifact helpers | machine | immutable |
| `.ged/PROJECT.md` | coordinator via `ged_memory` | brain/planning context | durable data | lazy, current summary |
| `.ged/reports/*.md` | coordinator via `ged_memory` | humans, explicit later planning | durable data | lazy substantive reports |
| `CONTEXT.md` | `ged_memory`/domain workflow/migration | brain/planning context | durable data | canonical vocabulary |
| `docs/adr/*.md` | `ged_memory`/migration | brain/planning context | durable data | sparse decision history |
| `.ged/STANDARDS.md` | explicit hash-bound import | brain prompt | approved instructions | rewritten from accepted bytes only |
| `.ged/work/<work-id>/DIRECT.md` | direct work open | coordinator/handoff | work input | one concise direct record |
| `.ged/work/<work-id>/{SPEC,TASKS,TESTS}.md` | planned work/planning | plan binding, workers, verifier | work input | planned mode only |
| `.ged/work/<work-id>/tasks/<task-id>/*` | work engine | retry, recovery, commit context | work evidence | work-scoped |
| `.agents/skills/<name>/SKILL.md` | explicit `ged_skill` call | Pi native discovery and Ged skill matching | reusable project configuration | persists across tasks |
| `.ged/SKILLS-STATE.json` | explicit `ged_skill` call | Ged hash-check and project skill lifecycle | machine provenance | lazy, never task-cleaned |
| `.ged/runtime/<work-id>/{STATE,SESSION-SUMMARY}.md` | explicit `ged_memory` projection/handoff | humans only | projection | optional, regenerable |
| `.ged/{GLOSSARY,DECISIONS}.md` | v3 migration | humans following pointer | compatibility | read-only pointer |

## Prompt trust

Package governance is trusted. `.ged/STANDARDS.md` is separately labeled as
approved project instructions. PROJECT, CONTEXT, ADR, work, repository-map,
research, and runtime-derived text are labeled data. Every dynamic section uses
a content-derived collision-safe frame, so embedded headings, fake messages,
tool directives, and delimiter text remain inside the data block. No embedded
content can override system/user intent, governance, scope, verification,
commit/push policy, or destructive-operation safety.

Ged excludes a project skill from its own matching when its recorded content
hash no longer matches. Pi's native discovery still treats manually managed
`.agents/skills/` files as trusted project configuration after the host's
normal project-trust decision. The provenance hash is evidence, not a sandbox.

## Version 3 migration

The idempotent migration:

1. runs legacy checkpoint backup/import first;
2. removes only byte-exact known placeholders;
3. backs up substantive legacy sources under ignored
   `.ged/runtime/migrations/durable-memory-v3/backups/` and journals each
   destructive action before replacing or removing its source;
4. appends glossary bytes exactly once to root `CONTEXT.md` and moves decision
   bytes into a non-conflicting migrated ADR;
5. scopes global task files only when ownership is unambiguous;
6. preserves and reports architecture, patterns, ideas, progress, skill
   registries, global plans, and legacy skills when no unambiguous canonical
   destination or unchanged generated provenance exists;
7. writes `.ged/MEMORY-MIGRATION.json` only after completion. A second run is a
   byte-for-byte no-op.

The migration lock records its process owner atomically. A later process
quarantines a lock only when that owner PID is no longer alive, then resumes
from the ignored journal so the final completion record retains pre-crash
evidence.

Completed legacy checkpoint migrations validate their immutable backups and
imported targets, not source paths that a later schema migration may relocate.
