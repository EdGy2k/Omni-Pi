# Context Map

Ged memory is current-state oriented. Durable root files describe the project as it is now; active work and runtime state are scoped by immutable work-item IDs rather than branches.

## Durable root memory

- `.ged/PROJECT.md` — product goal, users, constraints, success criteria, repo signals.
- `.ged/ARCHITECTURE.md` — current component boundaries and system shape.
- `.ged/PATTERNS.md` — conventions and implementation patterns.
- `.ged/GLOSSARY.md` — project/domain vocabulary.
- `.ged/DECISIONS.md` — durable decisions and rationale.
- `.ged/STANDARDS.md` — imported repo-wide agent standards.
- `.ged/SKILLS.md` — durable skill guidance.

## Active work memory

- `.ged/work/<work-id>/SPEC.md`
- `.ged/work/<work-id>/TASKS.md`
- `.ged/work/<work-id>/TESTS.md`
- `.ged/work/<work-id>/NOTES.md`
- `.ged/work/<work-id>/META.json`

## Runtime memory

- `.ged/runtime/active-work/<session-key>.json` (ignored session selection)
- `.ged/runtime/<work-id>/STATE.md`
- `.ged/runtime/<work-id>/SESSION-SUMMARY.md`
- `.ged/runtime/<work-id>/checkpoints.json`
